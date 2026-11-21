#pragma once

// Internals shared by the agent's source files. The wire format these
// constants describe is documented in docs/otav-protocol.md; keep the two and
// otav/src/protocol.ts in step.

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define OTAV_PROTO_VERSION 1
#define OTAV_AGENT_VERSION "0.1.0"

// Largest raw frame (type + seq + payload + crc) either side will send.
#define OTAV_MAX_PAYLOAD 4096
#define OTAV_MAX_RAW (OTAV_MAX_PAYLOAD + 7)

// Device -> host. JSON payloads unless noted.
enum {
    OTAV_T_HELLO = 0x01,      // chip, app, security, register catalogue
    OTAV_T_LOG = 0x02,        // one log line, UTF-8 text
    OTAV_T_PARTITIONS = 0x03, // partition table + running/boot/next
    OTAV_T_OTADATA = 0x04,    // both otadata entries
    OTAV_T_TELEMETRY = 0x05,  // heap, uptime, metrics
    OTAV_T_TASKS = 0x06,      // FreeRTOS task list
    OTAV_T_REGS = 0x07,       // peripheral register values
    OTAV_T_PCSAMPLES = 0x08,  // binary: u8 core, u8 n, u16 period_us, n x u32 pc
    OTAV_T_OTA_EVENT = 0x09,  // begin, image_info, end, set_boot, ...
    OTAV_T_OTA_PROGRESS = 0x0A,
    OTAV_T_ACK = 0x0B,        // reply to a host command
    OTAV_T_MEM = 0x0C,        // binary: u8 space, u32 addr, bytes
    OTAV_T_CPU = 0x0D,        // per-core special registers
    OTAV_T_CRASH = 0x0E,      // core dump summary from the previous run
};

// Host -> device.
enum {
    OTAV_C_HELLO = 0x81,      // resend hello, partitions, otadata, crash
    OTAV_C_SET_RATES = 0x82,  // JSON {"telemetry":10,...}
    OTAV_C_WATCH_REGS = 0x83, // JSON {"clear":bool,"add":[{"name","addr"}]}
    OTAV_C_READ_MEM = 0x84,   // binary: u8 space, u32 addr, u16 len
    OTAV_C_OTA_BEGIN = 0x85,  // JSON {"size":N}
    OTAV_C_OTA_DATA = 0x86,   // binary: u32 offset, bytes
    OTAV_C_OTA_END = 0x87,    // JSON {"reboot":bool}
    OTAV_C_OTA_ABORT = 0x88,
    OTAV_C_REBOOT = 0x89,
    OTAV_C_APP_STATE = 0x8A,  // JSON {"action":"valid"|"rollback"}
};

// --- link (otav_link.c) ----------------------------------------------------

typedef void (*otav_cmd_handler_t)(uint8_t type, uint16_t seq, const uint8_t *payload, size_t len);

esp_err_t otav_link_start(otav_cmd_handler_t handler, int priority);
/** Queues one frame; never blocks. Returns false (and counts a drop) if full. */
bool otav_send(uint8_t type, const void *payload, size_t len);
/** printf-style JSON (or text) frame, formatted into a bounded buffer. */
bool otav_sendf(uint8_t type, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void otav_ack(uint16_t seq, bool ok, const char *err, const char *extra_json);
uint32_t otav_link_drops(void);
bool otav_link_connected(void);

// --- json helper (otav_json.c) ---------------------------------------------

typedef struct {
    char *buf;
    size_t cap;
    size_t len;
    bool overflow;
} otav_json_t;

void oj_init(otav_json_t *j, char *buf, size_t cap);
void oj_raw(otav_json_t *j, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
/** Appends a JSON string literal, escaping as needed. */
void oj_str(otav_json_t *j, const char *s);
/** Removes a trailing comma, if any (for building lists in loops). */
void oj_trim_comma(otav_json_t *j);

// --- reports (otav_report.c) -----------------------------------------------

void otav_report_hello(void);
void otav_report_partitions(void);
void otav_report_otadata(void);
void otav_report_crash(void);
esp_err_t otav_report_start(int priority);
void otav_report_set_rates(const char *json, size_t len);
esp_err_t otav_report_watch_regs(const char *json, size_t len);
void otav_report_read_mem(uint16_t seq, const uint8_t *p, size_t len);

// --- ota (otav_ota.c) ------------------------------------------------------

void otav_ota_handle(uint8_t type, uint16_t seq, const uint8_t *payload, size_t len);
void otav_ota_boot_check(uint32_t mark_valid_after_ms);
void otav_ota_tick(void); // called by the sampler; flushes progress frames
void otav_ota_report_boot(void);

const char *otav_ota_state_name(uint32_t state);
