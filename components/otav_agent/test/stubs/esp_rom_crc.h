#pragma once
#include <stdint.h>
// Same algorithm as components/esp_rom/linux/esp_rom_crc.c in ESP-IDF.
static inline uint32_t esp_rom_crc32_le(uint32_t crc, uint8_t const *buf, uint32_t len)
{
    crc = ~crc;
    for (uint32_t i = 0; i < len; i++) {
        crc ^= buf[i];
        for (int k = 0; k < 8; k++) crc = (crc & 1) ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
    }
    return ~crc;
}
