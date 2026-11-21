#pragma once
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
typedef struct { int tx_buffer_size, rx_buffer_size; } usb_serial_jtag_driver_config_t;
#define USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT() (usb_serial_jtag_driver_config_t){0, 0}
static inline int usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t *c) { return 0; }
static inline bool usb_serial_jtag_is_connected(void) { return true; }
static inline int usb_serial_jtag_write_bytes(const void *p, size_t n, TickType_t t) { return n; }
static inline int usb_serial_jtag_read_bytes(void *p, size_t n, TickType_t t) { return 0; }
