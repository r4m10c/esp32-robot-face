// OTA wrapper and the USB OTA command handlers.
//
// Any OTA source goes through otav_ota_begin/write/end so the web app sees
// identical events whether the image came over USB from OTAV or (later) over
// Wi-Fi. Progress is reported at 10 Hz from the sampler task, not per write,
// so reporting cost does not scale with chunk size.

#include <inttypes.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "otav_agent.h"
#include "otav_priv.h"

static const char *TAG = "otav_ota";

#define HEADER_BYTES \
    (sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) + sizeof(esp_app_desc_t))
#define SECTOR 4096u

static struct {
    bool active;
    esp_ota_handle_t handle;
    const esp_partition_t *part;
    size_t image_size;
    volatile size_t written;
    size_t reported;
    int64_t started_us;
    int64_t last_report_us;
    uint8_t header[HEADER_BYTES];
    bool header_sent;
    char source[12];
} s;

static struct {
    char state[20];
    uint32_t auto_ms;
    int64_t valid_at_us; // 0 when not pending
} s_boot;

size_t otav_ota_written(void)
{
    return s.active ? s.written : 0;
}

static void event(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void event(const char *fmt, ...)
{
    char body[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(body, sizeof(body), fmt, ap);
    va_end(ap);
    otav_sendf(OTAV_T_OTA_EVENT, "{\"t\":%" PRId64 ",%s}", esp_timer_get_time(), body);
}

static void send_progress(void)
{
    const size_t w = s.written;
    const size_t erased = (w + SECTOR - 1) / SECTOR * SECTOR;
    otav_sendf(OTAV_T_OTA_PROGRESS,
               "{\"t\":%" PRId64 ",\"part\":\"%s\",\"addr\":%" PRIu32
               ",\"w\":%u,\"tot\":%u,\"erased\":%u}",
               esp_timer_get_time(), s.part ? s.part->label : "", s.part ? s.part->address : 0,
               (unsigned)w, (unsigned)s.image_size, (unsigned)erased);
    s.reported = w;
}

static void send_image_info(void)
{
    const esp_image_header_t *h = (const esp_image_header_t *)s.header;
    const esp_app_desc_t *d = (const esp_app_desc_t *)(s.header + sizeof(esp_image_header_t) +
                                                       sizeof(esp_image_segment_header_t));
    char sha[17];
    for (int i = 0; i < 8; i++) snprintf(&sha[2 * i], 3, "%02x", d->app_elf_sha256[i]);
    char proj[33], ver[33], idf[33];
    strlcpy(proj, d->project_name, sizeof(proj));
    strlcpy(ver, d->version, sizeof(ver));
    strlcpy(idf, d->idf_ver, sizeof(idf));
    event("\"ev\":\"image_info\",\"magic\":%u,\"segments\":%u,\"chip_id\":%u,\"entry\":%" PRIu32
          ",\"hash_appended\":%u,\"desc_ok\":%s,\"proj\":\"%s\",\"ver\":\"%s\",\"idf\":\"%s\","
          "\"sha\":\"%s\"",
          h->magic, h->segment_count, h->chip_id, h->entry_addr, h->hash_appended,
          d->magic_word == ESP_APP_DESC_MAGIC_WORD ? "true" : "false", proj, ver, idf, sha);
}

esp_err_t otav_ota_begin(size_t image_size, const char *source)
{
    if (s.active) return ESP_ERR_INVALID_STATE;
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (!part) return ESP_ERR_NOT_FOUND;
    if (image_size > part->size) return ESP_ERR_INVALID_SIZE;

    memset(&s, 0, sizeof(s));
    strlcpy(s.source, source ? source : "?", sizeof(s.source));
    s.part = part;
    s.image_size = image_size;
    s.started_us = esp_timer_get_time();
    event("\"ev\":\"begin\",\"src\":\"%s\",\"part\":\"%s\",\"addr\":%" PRIu32 ",\"size\":%" PRIu32
          ",\"image\":%u",
          s.source, part->label, part->address, part->size, (unsigned)image_size);

    esp_err_t err = esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &s.handle);
    if (err != ESP_OK) {
        event("\"ev\":\"error\",\"stage\":\"begin\",\"err\":\"%s\"", esp_err_to_name(err));
        return err;
    }
    s.active = true;
    ESP_LOGI(TAG, "OTA begin from %s into %s (%u bytes)", s.source, part->label,
             (unsigned)image_size);
    return ESP_OK;
}

esp_err_t otav_ota_write(const void *data, size_t len)
{
    if (!s.active) return ESP_ERR_INVALID_STATE;
    if (s.written < HEADER_BYTES) {
        size_t n = HEADER_BYTES - s.written;
        if (n > len) n = len;
        memcpy(&s.header[s.written], data, n);
    }
    esp_err_t err = esp_ota_write(s.handle, data, len);
    if (err != ESP_OK) {
        event("\"ev\":\"error\",\"stage\":\"write\",\"at\":%u,\"err\":\"%s\"", (unsigned)s.written,
              esp_err_to_name(err));
        return err;
    }
    s.written += len;
    if (!s.header_sent && s.written >= HEADER_BYTES) {
        s.header_sent = true;
        send_image_info();
    }
    return ESP_OK;
}

esp_err_t otav_ota_end(bool set_boot)
{
    if (!s.active) return ESP_ERR_INVALID_STATE;
    send_progress();
    s.active = false;
    const int64_t t0 = esp_timer_get_time();
    event("\"ev\":\"verify\",\"bytes\":%u", (unsigned)s.written);
    esp_err_t err = esp_ota_end(s.handle);
    const int64_t t1 = esp_timer_get_time();
    event("\"ev\":\"end\",\"ok\":%s,\"err\":\"%s\",\"bytes\":%u,\"write_ms\":%" PRId64
          ",\"verify_ms\":%" PRId64,
          err == ESP_OK ? "true" : "false", esp_err_to_name(err), (unsigned)s.written,
          (t0 - s.started_us) / 1000, (t1 - t0) / 1000);
    if (err != ESP_OK) return err;
    if (set_boot) {
        err = esp_ota_set_boot_partition(s.part);
        event("\"ev\":\"set_boot\",\"part\":\"%s\",\"ok\":%s,\"err\":\"%s\"", s.part->label,
              err == ESP_OK ? "true" : "false", esp_err_to_name(err));
        otav_report_otadata();
        otav_report_partitions();
    }
    return err;
}

void otav_ota_abort(const char *reason)
{
    if (!s.active) return;
    s.active = false;
    esp_ota_abort(s.handle);
    event("\"ev\":\"abort\",\"reason\":\"%s\",\"at\":%u", reason ? reason : "",
          (unsigned)s.written);
}

void otav_ota_tick(void)
{
    if (!s.active) return;
    const int64_t now = esp_timer_get_time();
    if (now - s.last_report_us >= 100000 && s.written != s.reported) {
        s.last_report_us = now;
        send_progress();
    }
}

// --- boot state + rollback -------------------------------------------------

static void report_boot(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    int64_t remaining = 0;
    if (s_boot.valid_at_us) {
        remaining = (s_boot.valid_at_us - esp_timer_get_time()) / 1000;
        if (remaining < 0) remaining = 0;
    }
    event("\"ev\":\"boot\",\"part\":\"%s\",\"state\":\"%s\",\"auto_valid_ms\":%" PRIu32
          ",\"valid_in_ms\":%" PRId64,
          run ? run->label : "", s_boot.state, s_boot.auto_ms, remaining);
}

static void mark_valid_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(s_boot.auto_ms));
    if (s_boot.valid_at_us) {
        esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
        s_boot.valid_at_us = 0;
        strlcpy(s_boot.state, err == ESP_OK ? "valid" : "pending_verify", sizeof(s_boot.state));
        event("\"ev\":\"marked_valid\",\"auto\":true,\"ok\":%s", err == ESP_OK ? "true" : "false");
        otav_report_otadata();
        otav_report_partitions();
    }
    vTaskDelete(NULL);
}

void otav_ota_boot_check(uint32_t mark_valid_after_ms)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    esp_ota_get_state_partition(run, &st);
    strlcpy(s_boot.state, otav_ota_state_name(st), sizeof(s_boot.state));
    s_boot.auto_ms = mark_valid_after_ms;
    if (st == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGW(TAG, "running image is PENDING_VERIFY; %s",
                 mark_valid_after_ms ? "auto-marking valid after a healthy run"
                                     : "waiting for a manual mark-valid from OTAV");
        if (mark_valid_after_ms) {
            s_boot.valid_at_us = esp_timer_get_time() + (int64_t)mark_valid_after_ms * 1000;
            xTaskCreate(mark_valid_task, "otav_valid", 3072, NULL, 3, NULL);
        }
    }
}

// --- USB OTA commands ------------------------------------------------------

static void reboot_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(400)); // let the ACK and events drain
    esp_restart();
}

static void schedule_reboot(void)
{
    event("\"ev\":\"reboot\"");
    xTaskCreate(reboot_task, "otav_rst", 2048, NULL, 10, NULL);
}

static double json_num(const uint8_t *p, size_t len, const char *key, double dflt)
{
    cJSON *root = cJSON_ParseWithLength((const char *)p, len);
    double v = dflt;
    if (root) {
        const cJSON *it = cJSON_GetObjectItem(root, key);
        if (cJSON_IsNumber(it)) v = it->valuedouble;
        if (cJSON_IsBool(it)) v = cJSON_IsTrue(it) ? 1 : 0;
        cJSON_Delete(root);
    }
    return v;
}

void otav_ota_handle(uint8_t type, uint16_t seq, const uint8_t *p, size_t len)
{
    char extra[96];
    switch (type) {
    case OTAV_C_OTA_BEGIN: {
        const double size = json_num(p, len, "size", 0);
        esp_err_t err = size > 0 ? otav_ota_begin((size_t)size, "usb") : ESP_ERR_INVALID_ARG;
        if (err == ESP_OK) {
            snprintf(extra, sizeof(extra), "\"part\":\"%s\",\"addr\":%" PRIu32, s.part->label,
                     s.part->address);
            otav_ack(seq, true, NULL, extra);
        } else {
            otav_ack(seq, false, esp_err_to_name(err), NULL);
        }
        break;
    }
    case OTAV_C_OTA_DATA: {
        if (len < 4 || !s.active) {
            otav_ack(seq, false, s.active ? "short" : "not_active", NULL);
            break;
        }
        const uint32_t off = p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24);
        esp_err_t err = ESP_OK;
        if (off != s.written) {
            snprintf(extra, sizeof(extra), "\"w\":%u", (unsigned)s.written);
            otav_ack(seq, false, "offset", extra);
            break;
        }
        err = otav_ota_write(p + 4, len - 4);
        snprintf(extra, sizeof(extra), "\"w\":%u", (unsigned)s.written);
        otav_ack(seq, err == ESP_OK, err == ESP_OK ? NULL : esp_err_to_name(err), extra);
        if (err != ESP_OK) otav_ota_abort("write_failed");
        break;
    }
    case OTAV_C_OTA_END: {
        const bool reboot = json_num(p, len, "reboot", 0) != 0;
        esp_err_t err = otav_ota_end(true);
        otav_ack(seq, err == ESP_OK, err == ESP_OK ? NULL : esp_err_to_name(err), NULL);
        if (err == ESP_OK && reboot) schedule_reboot();
        break;
    }
    case OTAV_C_OTA_ABORT:
        otav_ota_abort("host");
        otav_ack(seq, true, NULL, NULL);
        break;
    case OTAV_C_REBOOT:
        otav_ack(seq, true, NULL, NULL);
        schedule_reboot();
        break;
    case OTAV_C_APP_STATE: {
        cJSON *root = cJSON_ParseWithLength((const char *)p, len);
        const cJSON *a = root ? cJSON_GetObjectItem(root, "action") : NULL;
        esp_err_t err = ESP_ERR_INVALID_ARG;
        if (cJSON_IsString(a) && strcmp(a->valuestring, "valid") == 0) {
            err = esp_ota_mark_app_valid_cancel_rollback();
            if (err == ESP_OK) {
                s_boot.valid_at_us = 0;
                strlcpy(s_boot.state, "valid", sizeof(s_boot.state));
                event("\"ev\":\"marked_valid\",\"auto\":false,\"ok\":true");
            }
        } else if (cJSON_IsString(a) && strcmp(a->valuestring, "rollback") == 0) {
            event("\"ev\":\"rollback\"");
            otav_ack(seq, true, NULL, NULL);
            vTaskDelay(pdMS_TO_TICKS(300));
            // Reboots into the previous valid image; returns only on failure.
            err = esp_ota_mark_app_invalid_rollback_and_reboot();
            event("\"ev\":\"error\",\"stage\":\"rollback\",\"err\":\"%s\"", esp_err_to_name(err));
            cJSON_Delete(root);
            break;
        }
        cJSON_Delete(root);
        otav_ack(seq, err == ESP_OK, err == ESP_OK ? NULL : esp_err_to_name(err), NULL);
        otav_report_otadata();
        otav_report_partitions();
        break;
    }
    default:
        break;
    }
}

void otav_ota_report_boot(void)
{
    report_boot();
}
