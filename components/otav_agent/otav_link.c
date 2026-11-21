// Framed link over the ESP32-S3's USB Serial/JTAG port.
//
// Frame = COBS( type u8 | seq u16 LE | payload | crc32 LE ), with a 0x00
// delimiter before and after. CRC-32 is the zlib/IEEE one, computed over type,
// seq and payload. The leading delimiter isolates any ROM or bootloader text
// that reaches the port before the agent starts.
//
// Producers encode straight into a no-split ring buffer, so sending never
// blocks and never allocates; when the host is not reading, frames are dropped
// and counted rather than stalling the caller.

#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"
#include "freertos/task.h"
#include "otav_priv.h"

#define TX_RING_BYTES (24 * 1024)
#define LOG_LINE_MAX 240

static RingbufHandle_t s_tx;
static otav_cmd_handler_t s_handler;
static volatile uint32_t s_drops;
static volatile uint16_t s_seq;
static vprintf_like_t s_prev_vprintf;
static bool s_started;

// --- COBS ------------------------------------------------------------------

typedef struct {
    uint8_t *out;
    size_t pos;      // next write position
    size_t code_at;  // position of the current block's code byte
    uint8_t code;    // current block length + 1
} cobs_enc_t;

static void cobs_begin(cobs_enc_t *e, uint8_t *out)
{
    e->out = out;
    e->code_at = 0;
    e->pos = 1;
    e->code = 1;
}

static inline void cobs_put(cobs_enc_t *e, uint8_t b)
{
    if (b == 0) {
        e->out[e->code_at] = e->code;
        e->code_at = e->pos++;
        e->code = 1;
        return;
    }
    e->out[e->pos++] = b;
    if (++e->code == 0xFF) {
        e->out[e->code_at] = e->code;
        e->code_at = e->pos++;
        e->code = 1;
    }
}

static size_t cobs_end(cobs_enc_t *e)
{
    e->out[e->code_at] = e->code;
    return e->pos;
}

static void cobs_put_buf(cobs_enc_t *e, const uint8_t *p, size_t n)
{
    for (size_t i = 0; i < n; i++) cobs_put(e, p[i]);
}

// Decodes in place; returns decoded length or -1 on a malformed frame.
static int cobs_decode(uint8_t *buf, size_t len)
{
    size_t in = 0, out = 0;
    while (in < len) {
        uint8_t code = buf[in++];
        if (code == 0) return -1;
        for (uint8_t i = 1; i < code; i++) {
            if (in >= len) return -1;
            buf[out++] = buf[in++];
        }
        if (code != 0xFF && in < len) buf[out++] = 0;
    }
    return (int)out;
}

// --- sending ---------------------------------------------------------------

bool otav_send(uint8_t type, const void *payload, size_t len)
{
    if (!s_started || len > OTAV_MAX_PAYLOAD) {
        s_drops++;
        return false;
    }
    const size_t raw = 1 + 2 + len + 4;
    const size_t enc_max = 1 + raw + raw / 254 + 2 + 1;

    void *slot = NULL;
    if (xRingbufferSendAcquire(s_tx, &slot, enc_max, 0) != pdTRUE || slot == NULL) {
        s_drops++;
        return false;
    }

    const uint16_t seq = s_seq++;
    const uint8_t hdr[3] = {type, (uint8_t)seq, (uint8_t)(seq >> 8)};
    uint32_t crc = esp_rom_crc32_le(0, hdr, sizeof(hdr));
    if (len) crc = esp_rom_crc32_le(crc, payload, len);
    const uint8_t tail[4] = {(uint8_t)crc, (uint8_t)(crc >> 8), (uint8_t)(crc >> 16),
                             (uint8_t)(crc >> 24)};

    uint8_t *out = slot;
    out[0] = 0x00;
    cobs_enc_t e;
    cobs_begin(&e, out + 1);
    cobs_put_buf(&e, hdr, sizeof(hdr));
    cobs_put_buf(&e, payload, len);
    cobs_put_buf(&e, tail, sizeof(tail));
    size_t n = 1 + cobs_end(&e);
    // Pad the reserved slot with delimiters; empty frames are ignored by the host.
    memset(out + n, 0x00, enc_max - n);

    xRingbufferSendComplete(s_tx, slot);
    return true;
}

bool otav_sendf(uint8_t type, const char *fmt, ...)
{
    char buf[768];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0) return false;
    if ((size_t)n >= sizeof(buf)) n = sizeof(buf) - 1;
    return otav_send(type, buf, (size_t)n);
}

void otav_ack(uint16_t seq, bool ok, const char *err, const char *extra_json)
{
    char buf[256];
    otav_json_t j;
    oj_init(&j, buf, sizeof(buf));
    oj_raw(&j, "{\"seq\":%u,\"ok\":%s", seq, ok ? "true" : "false");
    if (err) {
        oj_raw(&j, ",\"err\":");
        oj_str(&j, err);
    }
    if (extra_json) oj_raw(&j, ",%s", extra_json);
    oj_raw(&j, "}");
    otav_send(OTAV_T_ACK, buf, j.len);
}

uint32_t otav_link_drops(void)
{
    return s_drops;
}

bool otav_link_connected(void)
{
    return usb_serial_jtag_is_connected();
}

// --- tasks -----------------------------------------------------------------

static void tx_task(void *arg)
{
    for (;;) {
        size_t size = 0;
        uint8_t *item = xRingbufferReceive(s_tx, &size, portMAX_DELAY);
        if (!item) continue;
        if (usb_serial_jtag_is_connected()) {
            // Strip the zero padding at the tail of the slot (keep one delimiter).
            while (size > 1 && item[size - 1] == 0 && item[size - 2] == 0) size--;
            usb_serial_jtag_write_bytes(item, size, pdMS_TO_TICKS(50));
        } else {
            s_drops++;
        }
        vRingbufferReturnItem(s_tx, item);
    }
}

static void rx_task(void *arg)
{
    static uint8_t frame[OTAV_MAX_RAW + OTAV_MAX_RAW / 254 + 8];
    uint8_t chunk[256];
    size_t flen = 0;
    bool overflow = false;

    for (;;) {
        int n = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), portMAX_DELAY);
        for (int i = 0; i < n; i++) {
            uint8_t b = chunk[i];
            if (b != 0) {
                if (flen < sizeof(frame)) {
                    frame[flen++] = b;
                } else {
                    overflow = true;
                }
                continue;
            }
            // Delimiter: decode whatever we gathered.
            if (flen > 0 && !overflow) {
                int raw = cobs_decode(frame, flen);
                if (raw >= 7) {
                    uint32_t want = esp_rom_crc32_le(0, frame, raw - 4);
                    uint32_t got = frame[raw - 4] | (frame[raw - 3] << 8) |
                                   (frame[raw - 2] << 16) | ((uint32_t)frame[raw - 1] << 24);
                    if (want == got && s_handler) {
                        uint16_t seq = frame[1] | (frame[2] << 8);
                        s_handler(frame[0], seq, frame + 3, raw - 7);
                    }
                }
            }
            flen = 0;
            overflow = false;
        }
    }
}

// --- logs ------------------------------------------------------------------

static int log_hook(const char *fmt, va_list ap)
{
    int ret = 0;
    if (s_prev_vprintf) {
        va_list copy;
        va_copy(copy, ap);
        ret = s_prev_vprintf(fmt, copy);
        va_end(copy);
    }
    if (!xPortInIsrContext() && xTaskGetSchedulerState() == taskSCHEDULER_RUNNING) {
        char line[LOG_LINE_MAX];
        int n = vsnprintf(line, sizeof(line), fmt, ap);
        if (n > 0) {
            if (n >= (int)sizeof(line)) n = sizeof(line) - 1;
            // Drop the trailing newline and ANSI colour codes are left for the host.
            while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) n--;
            if (n > 0) otav_send(OTAV_T_LOG, line, (size_t)n);
        }
    }
    return ret;
}

esp_err_t otav_link_start(otav_cmd_handler_t handler, int priority)
{
    s_handler = handler;
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    cfg.tx_buffer_size = 4096;
    cfg.rx_buffer_size = 8192;
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    if (err != ESP_OK) return err;

    s_tx = xRingbufferCreate(TX_RING_BYTES, RINGBUF_TYPE_NOSPLIT);
    if (!s_tx) return ESP_ERR_NO_MEM;
    s_started = true;

    if (xTaskCreate(tx_task, "otav_tx", 3072, NULL, priority, NULL) != pdPASS) return ESP_ERR_NO_MEM;
    if (xTaskCreate(rx_task, "otav_rx", 6144, NULL, priority, NULL) != pdPASS) return ESP_ERR_NO_MEM;

    s_prev_vprintf = esp_log_set_vprintf(log_hook);
    return ESP_OK;
}
