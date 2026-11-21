// Everything the agent reports on its own: device identity, flash layout,
// otadata, crash summary, and the periodic streams (telemetry, registers, CPU
// special registers, tasks, sampled program counters).

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_core_dump.h"
#include "esp_cpu.h"
#include "esp_flash.h"
#include "esp_flash_encrypt.h"
#include "esp_flash_partitions.h"
#include "esp_heap_caps.h"
#include "esp_ipc.h"
#include "esp_mac.h"
#include "esp_memory_utils.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_rom_crc.h"
#include "esp_secure_boot.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "otav_agent.h"
#include "otav_priv.h"
#include "soc/assist_debug_reg.h"
#include "soc/extmem_reg.h"
#include "soc/rtc_cntl_reg.h"
#include "soc/soc.h"
#include "soc/spi_mem_reg.h"
#include "soc/spi_reg.h"
#include "soc/system_reg.h"
#include "soc/timer_group_reg.h"
#include "soc/usb_serial_jtag_reg.h"

// --- rates -----------------------------------------------------------------

typedef struct {
    float telemetry, regs, cpu, tasks, otadata, pc;
} rates_t;

static rates_t s_rates = {
    .telemetry = 10, .regs = 10, .cpu = 2, .tasks = 1, .otadata = 1, .pc = 500,
};

// --- metrics ---------------------------------------------------------------

#define MAX_METRICS 8
static struct {
    char name[16];
    float value;
} s_metrics[MAX_METRICS];
static portMUX_TYPE s_metrics_lock = portMUX_INITIALIZER_UNLOCKED;

void otav_agent_metric(const char *name, float value)
{
    taskENTER_CRITICAL(&s_metrics_lock);
    int slot = -1;
    for (int i = 0; i < MAX_METRICS; i++) {
        if (s_metrics[i].name[0] == 0) {
            if (slot < 0) slot = i;
            break;
        }
        if (strncmp(s_metrics[i].name, name, sizeof(s_metrics[i].name)) == 0) {
            slot = i;
            break;
        }
    }
    if (slot >= 0) {
        if (s_metrics[slot].name[0] == 0) {
            strlcpy(s_metrics[slot].name, name, sizeof(s_metrics[slot].name));
        }
        s_metrics[slot].value = value;
    }
    taskEXIT_CRITICAL(&s_metrics_lock);
}

// --- register watch list ---------------------------------------------------

#define MAX_REGS 48
typedef struct {
    char name[28];
    char group[12];
    uint32_t addr;
} reg_t;

static reg_t s_regs[MAX_REGS];
static int s_reg_count;
static portMUX_TYPE s_regs_lock = portMUX_INITIALIZER_UNLOCKED;

static void reg_add(const char *group, const char *name, uint32_t addr)
{
    if (s_reg_count >= MAX_REGS) return;
    reg_t *r = &s_regs[s_reg_count++];
    strlcpy(r->group, group, sizeof(r->group));
    strlcpy(r->name, name, sizeof(r->name));
    r->addr = addr;
}

// The default catalogue: registers that say something about flash, cache,
// watchdogs, clocks and the two buses this firmware drives. All are plain
// status/config registers with no read side effects.
static void regs_default(void)
{
    s_reg_count = 0;
    reg_add("flash", "SPI_MEM_CMD_REG(1)", SPI_MEM_CMD_REG(1));
    reg_add("flash", "SPI_MEM_CMD_REG(0)", SPI_MEM_CMD_REG(0));
    reg_add("flash", "SPI_MEM_CLOCK_REG(0)", SPI_MEM_CLOCK_REG(0));
    reg_add("cache", "EXTMEM_ICACHE_CTRL_REG", EXTMEM_ICACHE_CTRL_REG);
    reg_add("cache", "EXTMEM_DCACHE_CTRL_REG", EXTMEM_DCACHE_CTRL_REG);
    reg_add("wdt", "TIMG_WDTCONFIG0_REG(0)", TIMG_WDTCONFIG0_REG(0));
    reg_add("wdt", "TIMG_WDTCONFIG0_REG(1)", TIMG_WDTCONFIG0_REG(1));
    reg_add("wdt", "RTC_CNTL_WDTCONFIG0_REG", RTC_CNTL_WDTCONFIG0_REG);
    reg_add("reset", "RTC_CNTL_RESET_STATE_REG", RTC_CNTL_RESET_STATE_REG);
    reg_add("clock", "SYSTEM_CPU_PER_CONF_REG", SYSTEM_CPU_PER_CONF_REG);
    reg_add("display", "SPI_CMD_REG(2)", SPI_CMD_REG(2));
    reg_add("display", "SPI_CLOCK_REG(2)", SPI_CLOCK_REG(2));
    reg_add("usb", "USB_SERIAL_JTAG_FRAM_NUM_REG", USB_SERIAL_JTAG_FRAM_NUM_REG);
}

// Reading these pops data out of a FIFO, so it would corrupt the peripheral's
// traffic (the USB one would corrupt the agent's own link).
static bool reg_addr_allowed(uint32_t addr)
{
    if (addr & 3) return false;
    if (addr < 0x60000000 || addr > 0x600D0FFC) return false;
    static const uint32_t deny[] = {
        DR_REG_UART_BASE, DR_REG_UART1_BASE, DR_REG_UART2_BASE, DR_REG_USB_SERIAL_JTAG_BASE,
    };
    for (size_t i = 0; i < sizeof(deny) / sizeof(deny[0]); i++) {
        if (addr == deny[i]) return false;
    }
    // RMT channel data (FIFO) registers.
    if (addr >= DR_REG_RMT_BASE && addr < DR_REG_RMT_BASE + 0x20) return false;
    return true;
}

esp_err_t otav_report_watch_regs(const char *json, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(json, len);
    if (!root) return ESP_ERR_INVALID_ARG;
    esp_err_t err = ESP_OK;
    taskENTER_CRITICAL(&s_regs_lock);
    if (cJSON_IsTrue(cJSON_GetObjectItem(root, "reset"))) regs_default();
    if (cJSON_IsTrue(cJSON_GetObjectItem(root, "clear"))) s_reg_count = 0;
    taskEXIT_CRITICAL(&s_regs_lock);

    const cJSON *add = cJSON_GetObjectItem(root, "add");
    const cJSON *it;
    cJSON_ArrayForEach(it, add)
    {
        const cJSON *a = cJSON_GetObjectItem(it, "addr");
        const cJSON *n = cJSON_GetObjectItem(it, "name");
        const cJSON *g = cJSON_GetObjectItem(it, "group");
        if (!cJSON_IsNumber(a)) continue;
        uint32_t addr = (uint32_t)a->valuedouble;
        if (!reg_addr_allowed(addr)) {
            err = ESP_ERR_NOT_ALLOWED;
            continue;
        }
        taskENTER_CRITICAL(&s_regs_lock);
        reg_add(cJSON_IsString(g) ? g->valuestring : "user",
                cJSON_IsString(n) ? n->valuestring : "reg", addr);
        taskEXIT_CRITICAL(&s_regs_lock);
    }
    cJSON_Delete(root);
    return err;
}

static void send_regs(void)
{
    char buf[1600];
    otav_json_t j;
    oj_init(&j, buf, sizeof(buf));
    uint32_t addr[MAX_REGS], val[MAX_REGS];
    int n = 0;
    taskENTER_CRITICAL(&s_regs_lock);
    for (; n < s_reg_count; n++) {
        addr[n] = s_regs[n].addr;
        val[n] = REG_READ(addr[n]);
    }
    taskEXIT_CRITICAL(&s_regs_lock);
    oj_raw(&j, "{\"t\":%" PRId64 ",\"r\":[", esp_timer_get_time());
    for (int i = 0; i < n; i++) {
        oj_raw(&j, "[%" PRIu32 ",%" PRIu32 "],", addr[i], val[i]);
    }
    oj_trim_comma(&j);
    oj_raw(&j, "]}");
    if (!j.overflow) otav_send(OTAV_T_REGS, buf, j.len);
}

static void regs_catalogue(otav_json_t *j)
{
    reg_t *copy = malloc(sizeof(s_regs));
    if (!copy) return;
    taskENTER_CRITICAL(&s_regs_lock);
    const int n = s_reg_count;
    memcpy(copy, s_regs, sizeof(s_regs));
    taskEXIT_CRITICAL(&s_regs_lock);
    oj_raw(j, "\"regs\":[");
    for (int i = 0; i < n; i++) {
        oj_raw(j, "{\"n\":");
        oj_str(j, copy[i].name);
        oj_raw(j, ",\"g\":");
        oj_str(j, copy[i].group);
        oj_raw(j, ",\"a\":%" PRIu32 "},", copy[i].addr);
    }
    free(copy);
    oj_trim_comma(j);
    oj_raw(j, "]");
}

// --- hello -----------------------------------------------------------------

static const char *reset_name(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_EXT: return "external";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    case ESP_RST_USB: return "usb";
    case ESP_RST_JTAG: return "jtag";
    default: return "unknown";
    }
}

static void hex(char *out, const uint8_t *p, size_t n)
{
    static const char d[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = d[p[i] >> 4];
        out[2 * i + 1] = d[p[i] & 15];
    }
    out[2 * n] = 0;
}

static void app_desc_json(otav_json_t *j, const esp_app_desc_t *d)
{
    char sha[65];
    hex(sha, d->app_elf_sha256, 32);
    oj_raw(j, "{\"proj\":");
    oj_str(j, d->project_name);
    oj_raw(j, ",\"ver\":");
    oj_str(j, d->version);
    oj_raw(j, ",\"idf\":");
    oj_str(j, d->idf_ver);
    oj_raw(j, ",\"date\":");
    oj_str(j, d->date);
    oj_raw(j, ",\"time\":");
    oj_str(j, d->time);
    oj_raw(j, ",\"sha\":\"%s\"}", sha);
}

static void rates_json(otav_json_t *j)
{
    oj_raw(j,
           "\"rates\":{\"telemetry\":%.2f,\"regs\":%.2f,\"cpu\":%.2f,\"tasks\":%.2f,"
           "\"otadata\":%.2f,\"pc\":%.0f}",
           s_rates.telemetry, s_rates.regs, s_rates.cpu, s_rates.tasks, s_rates.otadata,
           s_rates.pc);
}

void otav_report_hello(void)
{
    const size_t cap = 3072;
    char *buf = malloc(cap);
    if (!buf) return;
    otav_json_t j;
    oj_init(&j, buf, cap);

    esp_chip_info_t chip;
    esp_chip_info(&chip);
    uint32_t flash = 0;
    esp_flash_get_size(NULL, &flash);
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);

    oj_raw(&j,
           "{\"proto\":%d,\"agent\":\"%s\",\"chip\":\"esp32s3\",\"rev\":%u,\"cores\":%u,"
           "\"cpu_mhz\":%d,\"flash\":%" PRIu32 ",\"psram\":%u,"
           "\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"reset\":\"%s\",\"uptime_us\":%" PRId64 ",",
           OTAV_PROTO_VERSION, OTAV_AGENT_VERSION, chip.revision, chip.cores,
           CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ, flash,
           (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM), mac[0], mac[1], mac[2], mac[3],
           mac[4], mac[5], reset_name(esp_reset_reason()), esp_timer_get_time());
    oj_raw(&j, "\"app\":");
    app_desc_json(&j, esp_app_get_description());
    oj_raw(&j, ",\"sec\":{\"flash_enc\":%s,\"secure_boot\":%s},",
           esp_flash_encryption_enabled() ? "true" : "false",
           esp_secure_boot_enabled() ? "true" : "false");
    rates_json(&j);
    oj_raw(&j, ",");
    regs_catalogue(&j);
    oj_raw(&j, "}");
    if (!j.overflow) otav_send(OTAV_T_HELLO, buf, j.len);
    free(buf);
}

// --- partitions ------------------------------------------------------------

const char *otav_ota_state_name(uint32_t state)
{
    switch (state) {
    case ESP_OTA_IMG_NEW: return "new";
    case ESP_OTA_IMG_PENDING_VERIFY: return "pending_verify";
    case ESP_OTA_IMG_VALID: return "valid";
    case ESP_OTA_IMG_INVALID: return "invalid";
    case ESP_OTA_IMG_ABORTED: return "aborted";
    case ESP_OTA_IMG_UNDEFINED: return "undefined";
    default: return "unknown";
    }
}

static void label_or_null(otav_json_t *j, const char *key, const esp_partition_t *p)
{
    oj_raw(j, "\"%s\":", key);
    if (p) {
        oj_str(j, p->label);
    } else {
        oj_raw(j, "null");
    }
    oj_raw(j, ",");
}

void otav_report_partitions(void)
{
    const size_t cap = 4096;
    char *buf = malloc(cap);
    if (!buf) return;
    otav_json_t j;
    oj_init(&j, buf, cap);

    uint32_t flash = 0;
    esp_flash_get_size(NULL, &flash);
    oj_raw(&j, "{\"flash\":%" PRIu32 ",", flash);
    label_or_null(&j, "running", esp_ota_get_running_partition());
    label_or_null(&j, "boot", esp_ota_get_boot_partition());
    label_or_null(&j, "next", esp_ota_get_next_update_partition(NULL));
    label_or_null(&j, "last_invalid", esp_ota_get_last_invalid_partition());
    oj_raw(&j, "\"parts\":[");

    esp_partition_iterator_t it =
        esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    for (; it; it = esp_partition_next(it)) {
        const esp_partition_t *p = esp_partition_get(it);
        oj_raw(&j, "{\"l\":");
        oj_str(&j, p->label);
        oj_raw(&j, ",\"t\":%d,\"st\":%d,\"o\":%" PRIu32 ",\"s\":%" PRIu32 ",\"enc\":%s", p->type,
               p->subtype, p->address, p->size, p->encrypted ? "true" : "false");
        if (p->type == ESP_PARTITION_TYPE_APP) {
            esp_app_desc_t d;
            if (esp_ota_get_partition_description(p, &d) == ESP_OK) {
                oj_raw(&j, ",\"app\":");
                app_desc_json(&j, &d);
            }
            esp_ota_img_states_t st;
            if (esp_ota_get_state_partition(p, &st) == ESP_OK) {
                oj_raw(&j, ",\"state\":\"%s\"", otav_ota_state_name(st));
            }
        }
        oj_raw(&j, "},");
    }
    esp_partition_iterator_release(it);
    oj_trim_comma(&j);
    oj_raw(&j, "]}");
    if (!j.overflow) otav_send(OTAV_T_PARTITIONS, buf, j.len);
    free(buf);
}

// --- otadata ---------------------------------------------------------------

static int ota_slot_count(void)
{
    int n = 0;
    esp_partition_iterator_t it =
        esp_partition_find(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, NULL);
    for (; it; it = esp_partition_next(it)) {
        const esp_partition_t *p = esp_partition_get(it);
        if (p->subtype >= ESP_PARTITION_SUBTYPE_APP_OTA_MIN &&
            p->subtype < ESP_PARTITION_SUBTYPE_APP_OTA_MAX) {
            n++;
        }
    }
    esp_partition_iterator_release(it);
    return n;
}

void otav_report_otadata(void)
{
    const esp_partition_t *od =
        esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, NULL);
    if (!od) return;

    esp_ota_select_entry_t e[2];
    for (int i = 0; i < 2; i++) {
        if (esp_partition_read(od, i * 0x1000, &e[i], sizeof(e[i])) != ESP_OK) {
            memset(&e[i], 0xFF, sizeof(e[i]));
        }
    }

    char buf[768];
    otav_json_t j;
    oj_init(&j, buf, sizeof(buf));
    const int slots = ota_slot_count();
    oj_raw(&j, "{\"t\":%" PRId64 ",\"addr\":%" PRIu32 ",\"slots\":%d,\"e\":[",
           esp_timer_get_time(), od->address, slots);

    int best = -1;
    for (int i = 0; i < 2; i++) {
        const uint32_t crc = esp_rom_crc32_le(UINT32_MAX, (const uint8_t *)&e[i].ota_seq, 4);
        const bool crc_ok = e[i].ota_seq != UINT32_MAX && crc == e[i].crc;
        const bool usable = crc_ok && e[i].ota_state != ESP_OTA_IMG_INVALID &&
                            e[i].ota_state != ESP_OTA_IMG_ABORTED;
        if (usable && (best < 0 || e[i].ota_seq > e[best].ota_seq)) best = i;
        char raw[2 * sizeof(e[i]) + 1];
        hex(raw, (const uint8_t *)&e[i], sizeof(e[i]));
        oj_raw(&j,
               "{\"seq\":%" PRIu32 ",\"state\":%" PRIu32 ",\"stn\":\"%s\",\"crc\":%" PRIu32
               ",\"crc_ok\":%s,\"raw\":\"%s\"},",
               e[i].ota_seq, e[i].ota_state, otav_ota_state_name(e[i].ota_state), e[i].crc,
               crc_ok ? "true" : "false", raw);
    }
    oj_trim_comma(&j);
    oj_raw(&j, "],\"active\":%d,\"boot_slot\":", best);
    if (best >= 0 && slots > 0) {
        oj_raw(&j, "%" PRIu32 "}", (e[best].ota_seq - 1) % (uint32_t)slots);
    } else {
        oj_raw(&j, "null}");
    }
    if (!j.overflow) otav_send(OTAV_T_OTADATA, buf, j.len);
}

// --- crash -----------------------------------------------------------------

void otav_report_crash(void)
{
    if (esp_core_dump_image_check() != ESP_OK) return;
    esp_core_dump_summary_t *s = calloc(1, sizeof(*s));
    if (!s) return;
    if (esp_core_dump_get_summary(s) != ESP_OK) {
        free(s);
        return;
    }
    const size_t cap = 2048;
    char *buf = malloc(cap);
    if (!buf) {
        free(s);
        return;
    }
    otav_json_t j;
    oj_init(&j, buf, cap);
    char reason[160] = "";
    esp_core_dump_get_panic_reason(reason, sizeof(reason));
    oj_raw(&j, "{\"task\":");
    oj_str(&j, s->exc_task);
    oj_raw(&j, ",\"pc\":%" PRIu32 ",\"cause\":%" PRIu32 ",\"vaddr\":%" PRIu32 ",\"reason\":",
           s->exc_pc, s->ex_info.exc_cause, s->ex_info.exc_vaddr);
    oj_str(&j, reason);
    oj_raw(&j, ",\"a\":[");
    for (int i = 0; i < 16; i++) oj_raw(&j, "%" PRIu32 ",", s->ex_info.exc_a[i]);
    oj_trim_comma(&j);
    oj_raw(&j, "],\"bt\":[");
    for (uint32_t i = 0; i < s->exc_bt_info.depth && i < 16; i++) {
        oj_raw(&j, "%" PRIu32 ",", s->exc_bt_info.bt[i]);
    }
    oj_trim_comma(&j);
    oj_raw(&j, "],\"bt_corrupt\":%s,\"elf_sha\":", s->exc_bt_info.corrupted ? "true" : "false");
    oj_str(&j, (const char *)s->app_elf_sha256);
    oj_raw(&j, "}");
    if (!j.overflow) otav_send(OTAV_T_CRASH, buf, j.len);
    free(buf);
    free(s);
}

// --- telemetry -------------------------------------------------------------

static void send_telemetry(void)
{
    char buf[1024];
    otav_json_t j;
    oj_init(&j, buf, sizeof(buf));
    oj_raw(&j,
           "{\"t\":%" PRId64 ",\"heap\":%u,\"heap_min\":%u,\"heap_big\":%u,\"heap_tot\":%u,"
           "\"psram\":%u,\"psram_tot\":%u,\"drops\":%" PRIu32 ",\"ota_w\":%u,\"m\":{",
           esp_timer_get_time(), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_total_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
           (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM), otav_link_drops(),
           (unsigned)otav_ota_written());
    taskENTER_CRITICAL(&s_metrics_lock);
    typeof(s_metrics) copy;
    memcpy(copy, s_metrics, sizeof(copy));
    taskEXIT_CRITICAL(&s_metrics_lock);
    for (int i = 0; i < MAX_METRICS && copy[i].name[0]; i++) {
        oj_str(&j, copy[i].name);
        oj_raw(&j, ":%.3f,", (double)copy[i].value);
    }
    oj_trim_comma(&j);
    oj_raw(&j, "},");
    otav_link_stats_json(&j);
    oj_raw(&j, "}");
    if (!j.overflow) otav_send(OTAV_T_TELEMETRY, buf, j.len);
}

// --- tasks -----------------------------------------------------------------

static void send_tasks(void)
{
    UBaseType_t n = uxTaskGetNumberOfTasks() + 4;
    TaskStatus_t *ts = malloc(n * sizeof(*ts));
    if (!ts) return;
    configRUN_TIME_COUNTER_TYPE total = 0;
    n = uxTaskGetSystemState(ts, n, &total);

    const size_t cap = 3072;
    char *buf = malloc(cap);
    if (!buf) {
        free(ts);
        return;
    }
    otav_json_t j;
    oj_init(&j, buf, cap);
    oj_raw(&j, "{\"t\":%" PRId64 ",\"total\":%" PRIu64 ",\"tasks\":[", esp_timer_get_time(),
           (uint64_t)total);
    for (UBaseType_t i = 0; i < n; i++) {
        BaseType_t core = xTaskGetCoreID(ts[i].xHandle);
        oj_raw(&j, "{\"n\":");
        oj_str(&j, ts[i].pcTaskName);
        oj_raw(&j,
               ",\"id\":%u,\"s\":%d,\"p\":%u,\"c\":%d,\"hw\":%" PRIu32 ",\"rt\":%" PRIu64 "},",
               (unsigned)ts[i].xTaskNumber, ts[i].eCurrentState,
               (unsigned)ts[i].uxCurrentPriority, core == tskNO_AFFINITY ? -1 : (int)core,
               (uint32_t)ts[i].usStackHighWaterMark, (uint64_t)ts[i].ulRunTimeCounter);
    }
    oj_trim_comma(&j);
    oj_raw(&j, "]}");
    if (!j.overflow) otav_send(OTAV_T_TASKS, buf, j.len);
    free(buf);
    free(ts);
}

// --- CPU special registers -------------------------------------------------

typedef struct {
    uint32_t ps, sar, lbeg, lend, lcount, windowbase, windowstart, ccount, ccompare0,
        intenable, interrupt, vecbase, cpenable, prid, exccause, excvaddr, sp;
} cpu_snap_t;

#define OTAV_RSR(name, out) __asm__ volatile("rsr." #name " %0" : "=r"(out))

static void IRAM_ATTR cpu_snap(void *arg)
{
    cpu_snap_t *s = arg;
    OTAV_RSR(ps, s->ps);
    OTAV_RSR(sar, s->sar);
    OTAV_RSR(lbeg, s->lbeg);
    OTAV_RSR(lend, s->lend);
    OTAV_RSR(lcount, s->lcount);
    OTAV_RSR(windowbase, s->windowbase);
    OTAV_RSR(windowstart, s->windowstart);
    OTAV_RSR(ccount, s->ccount);
    OTAV_RSR(ccompare0, s->ccompare0);
    OTAV_RSR(intenable, s->intenable);
    OTAV_RSR(interrupt, s->interrupt);
    OTAV_RSR(vecbase, s->vecbase);
    OTAV_RSR(cpenable, s->cpenable);
    OTAV_RSR(prid, s->prid);
    OTAV_RSR(exccause, s->exccause);
    OTAV_RSR(excvaddr, s->excvaddr);
    __asm__ volatile("mov %0, a1" : "=r"(s->sp));
}

static void send_cpu(void)
{
    char buf[900];
    otav_json_t j;
    oj_init(&j, buf, sizeof(buf));
    oj_raw(&j, "{\"t\":%" PRId64 ",\"cores\":[", esp_timer_get_time());
    for (int core = 0; core < portNUM_PROCESSORS; core++) {
        cpu_snap_t s = {0};
        if (core == esp_cpu_get_core_id()) {
            cpu_snap(&s);
        } else if (esp_ipc_call_blocking(core, cpu_snap, &s) != ESP_OK) {
            continue;
        }
        oj_raw(&j,
               "{\"core\":%d,\"PS\":%" PRIu32 ",\"SAR\":%" PRIu32 ",\"LBEG\":%" PRIu32
               ",\"LEND\":%" PRIu32 ",\"LCOUNT\":%" PRIu32 ",\"WINDOWBASE\":%" PRIu32
               ",\"WINDOWSTART\":%" PRIu32 ",\"CCOUNT\":%" PRIu32 ",\"CCOMPARE0\":%" PRIu32
               ",\"INTENABLE\":%" PRIu32 ",\"INTERRUPT\":%" PRIu32 ",\"VECBASE\":%" PRIu32
               ",\"CPENABLE\":%" PRIu32 ",\"PRID\":%" PRIu32 ",\"EXCCAUSE\":%" PRIu32
               ",\"EXCVADDR\":%" PRIu32 ",\"SP\":%" PRIu32 "},",
               core, s.ps, s.sar, s.lbeg, s.lend, s.lcount, s.windowbase, s.windowstart,
               s.ccount, s.ccompare0, s.intenable, s.interrupt, s.vecbase, s.cpenable, s.prid,
               s.exccause, s.excvaddr, s.sp);
    }
    oj_trim_comma(&j);
    oj_raw(&j, "]}");
    if (!j.overflow) otav_send(OTAV_T_CPU, buf, j.len);
}

// --- PC sampling -----------------------------------------------------------
//
// The ASSIST_DEBUG block records each core's program counter while
// RCD_RECORDING is set. A small task pinned to one core reads the *other*
// core's PC (reading your own would only ever show the sampler), so the pair
// gives a non-halting statistical profile of both cores.

#define PC_BATCH 64

static void pc_enable(void)
{
    REG_SET_BIT(SYSTEM_CPU_PERI_CLK_EN_REG, SYSTEM_CLK_EN_ASSIST_DEBUG);
    REG_CLR_BIT(SYSTEM_CPU_PERI_RST_EN_REG, SYSTEM_RST_EN_ASSIST_DEBUG);
    REG_WRITE(ASSIST_DEBUG_CORE_0_RCD_PDEBUGENABLE_REG, ASSIST_DEBUG_CORE_0_RCD_PDEBUGENABLE);
    REG_WRITE(ASSIST_DEBUG_CORE_0_RCD_RECORDING_REG, ASSIST_DEBUG_CORE_0_RCD_RECORDING);
    REG_WRITE(ASSIST_DEBUG_CORE_1_RCD_PDEBUGENABLE_REG, ASSIST_DEBUG_CORE_1_RCD_PDEBUGENABLE);
    REG_WRITE(ASSIST_DEBUG_CORE_1_RCD_RECORDING_REG, ASSIST_DEBUG_CORE_1_RCD_RECORDING);
}

static void pc_task(void *arg)
{
    const int target = (int)(intptr_t)arg;
    const uint32_t reg =
        target == 0 ? ASSIST_DEBUG_CORE_0_RCD_PDEBUGPC_REG : ASSIST_DEBUG_CORE_1_RCD_PDEBUGPC_REG;
    uint8_t frame[4 + 4 * PC_BATCH];
    int n = 0;
    for (;;) {
        const float hz = s_rates.pc;
        if (hz <= 0 || !otav_link_connected()) {
            n = 0;
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }
        TickType_t period = (TickType_t)(configTICK_RATE_HZ / hz);
        if (period < 1) period = 1;

        const uint32_t pc = REG_READ(reg);
        memcpy(&frame[4 + 4 * n], &pc, 4);
        if (++n == PC_BATCH) {
            const uint16_t period_us = (uint16_t)(period * (1000000 / configTICK_RATE_HZ));
            frame[0] = (uint8_t)target;
            frame[1] = (uint8_t)n;
            frame[2] = (uint8_t)period_us;
            frame[3] = (uint8_t)(period_us >> 8);
            otav_send(OTAV_T_PCSAMPLES, frame, 4 + 4 * n);
            n = 0;
        }
        vTaskDelay(period);
    }
}

// --- memory reads ----------------------------------------------------------

void otav_report_read_mem(uint16_t seq, const uint8_t *p, size_t len)
{
    if (len < 7) {
        otav_ack(seq, false, "short", NULL);
        return;
    }
    const uint8_t space = p[0];
    const uint32_t addr = p[1] | (p[2] << 8) | (p[3] << 16) | ((uint32_t)p[4] << 24);
    uint16_t n = p[5] | (p[6] << 8);
    if (n == 0 || n > 2048) {
        otav_ack(seq, false, "len", NULL);
        return;
    }
    uint8_t *out = malloc(7 + n);
    if (!out) {
        otav_ack(seq, false, "nomem", NULL);
        return;
    }
    out[0] = (uint8_t)seq;
    out[1] = (uint8_t)(seq >> 8);
    memcpy(&out[2], p, 5); // space + addr
    esp_err_t err = ESP_OK;
    if (space == 0) {
        uint32_t flash = 0;
        esp_flash_get_size(NULL, &flash);
        err = (addr + n <= flash) ? esp_flash_read(NULL, &out[7], addr, n) : ESP_ERR_INVALID_SIZE;
    } else if (space == 1) {
        const void *a = (const void *)addr;
        const void *b = (const void *)(addr + n - 1);
        if ((esp_ptr_byte_accessible(a) && esp_ptr_byte_accessible(b)) ||
            (esp_ptr_external_ram(a) && esp_ptr_external_ram(b))) {
            memcpy(&out[7], a, n);
        } else {
            err = ESP_ERR_INVALID_ARG;
        }
    } else {
        err = ESP_ERR_NOT_SUPPORTED;
    }
    if (err == ESP_OK) {
        otav_send(OTAV_T_MEM, out, 7 + n);
        otav_ack(seq, true, NULL, NULL);
    } else {
        otav_ack(seq, false, esp_err_to_name(err), NULL);
    }
    free(out);
}

// --- rates + sampler loop --------------------------------------------------

void otav_report_set_rates(const char *json, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(json, len);
    if (!root) return;
#define RATE(field)                                                    \
    do {                                                               \
        const cJSON *v = cJSON_GetObjectItem(root, #field);            \
        if (cJSON_IsNumber(v) && v->valuedouble >= 0 && v->valuedouble <= 1000) \
            s_rates.field = (float)v->valuedouble;                    \
    } while (0)
    RATE(telemetry);
    RATE(regs);
    RATE(cpu);
    RATE(tasks);
    RATE(otadata);
    RATE(pc);
#undef RATE
    cJSON_Delete(root);
}

static bool due(int64_t now, int64_t *next, float hz)
{
    if (hz <= 0) return false;
    if (now < *next) return false;
    const int64_t period = (int64_t)(1000000.0f / hz);
    *next = (now - *next > period) ? now + period : *next + period;
    return true;
}

static void sampler_task(void *arg)
{
    int64_t n_tel = 0, n_regs = 0, n_cpu = 0, n_tasks = 0, n_od = 0;
    for (;;) {
        const int64_t now = esp_timer_get_time();
        otav_ota_tick();
        if (otav_link_connected()) {
            if (due(now, &n_tel, s_rates.telemetry)) send_telemetry();
            if (due(now, &n_regs, s_rates.regs)) send_regs();
            if (due(now, &n_cpu, s_rates.cpu)) send_cpu();
            if (due(now, &n_tasks, s_rates.tasks)) send_tasks();
            if (due(now, &n_od, s_rates.otadata)) otav_report_otadata();
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

esp_err_t otav_report_start(int priority)
{
    regs_default();
    pc_enable();
    if (xTaskCreate(sampler_task, "otav_smp", 5120, NULL, priority, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
#if !CONFIG_FREERTOS_UNICORE
    // Each sampler watches the other core.
    if (xTaskCreatePinnedToCore(pc_task, "otav_pc0", 2048, (void *)0, configMAX_PRIORITIES - 3,
                                NULL, 1) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    if (xTaskCreatePinnedToCore(pc_task, "otav_pc1", 2048, (void *)1, configMAX_PRIORITIES - 3,
                                NULL, 0) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
#endif
    return ESP_OK;
}
