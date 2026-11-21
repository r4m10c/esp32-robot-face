#pragma once

// OTAV agent: streams what the firmware is doing (OTA progress, otadata, flash
// layout, peripheral and CPU registers, sampled program counters, tasks, heap,
// logs) to the OTAV web app over the ESP32-S3's built-in USB Serial/JTAG port,
// and accepts commands back (USB OTA, register watch list, memory reads).
//
// It never halts the CPU: everything is read by the firmware itself, which is
// what keeps it safe to run during an OTA. The wire format is documented in
// docs/otav-protocol.md.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /** Mark a PENDING_VERIFY image valid after this long; 0 = never (manual). */
    uint32_t mark_valid_after_ms;
    /** FreeRTOS priority of the agent's link and sampler tasks. */
    int task_priority;
} otav_agent_config_t;

#define OTAV_AGENT_CONFIG_DEFAULT()                                  \
    (otav_agent_config_t)                                            \
    {                                                                \
        .mark_valid_after_ms = CONFIG_OTAV_MARK_VALID_AFTER_MS,      \
        .task_priority = 5,                                          \
    }

/** Installs the USB Serial/JTAG driver, hooks logging and starts the agent. */
esp_err_t otav_agent_start(const otav_agent_config_t *config);

/**
 * Publishes a named application metric (e.g. "fps"). Sent with every
 * telemetry frame. Up to 8 names; cheap enough to call every frame.
 */
void otav_agent_metric(const char *name, float value);

// ---------------------------------------------------------------------------
// OTA wrapper. Every OTA path (USB push from OTAV today, Wi-Fi later) goes
// through these so the web app sees the same events whatever the source.
// ---------------------------------------------------------------------------

/** Starts an update into the next OTA slot. `source` is a short tag, e.g. "usb". */
esp_err_t otav_ota_begin(size_t image_size, const char *source);

/** Appends image bytes; must be called with consecutive data. */
esp_err_t otav_ota_write(const void *data, size_t len);

/** Validates the image and, if `set_boot`, makes it the next boot partition. */
esp_err_t otav_ota_end(bool set_boot);

/** Abandons an update in progress. */
void otav_ota_abort(const char *reason);

/** Bytes written so far in the current update, or 0 when none is running. */
size_t otav_ota_written(void);

#ifdef __cplusplus
}
#endif
