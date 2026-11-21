# OTAV wire protocol (v1)

The OTAV agent (`components/otav_agent`) and the web app (`otav/`) talk over
the ESP32-S3's built-in USB Serial/JTAG port (USB VID:PID `303a:1001`). The
agent owns that port, so ESP-IDF logs travel inside the protocol as `LOG`
frames. The baud rate is irrelevant (USB).

Three implementations must agree: `otav_priv.h` + `otav_link.c` (firmware),
`otav/src/protocol.ts` (web app), and this file. `otav/src/interop.test.ts`
checks the JavaScript encoder byte-for-byte against the firmware encoder
(`components/otav_agent/test/host_frame_test.c`).

## Framing

```
0x00 | COBS( type u8 | seq u16 LE | payload | crc32 LE ) | 0x00
```

- COBS removes every zero, so `0x00` only ever delimits frames. Empty frames
  (two delimiters in a row) are ignored.
- CRC-32 is the zlib/IEEE one (`esp_rom_crc32_le(0, …)`), over type, seq and
  payload.
- Frames failing COBS or CRC are dropped. Text outside frames (ROM boot
  messages before the agent starts) is shown by the web app as noise.
- Max payload: 4096 bytes.
- `seq` counts up per direction. Every host command is answered by an `ACK`
  carrying the command's `seq`.

## Device → host

| Type | Name | Payload |
| --- | --- | --- |
| 0x01 | HELLO | JSON: proto, agent, chip, rev, cores, cpu_mhz, flash, psram, mac, reset reason, running app descriptor, security state, stream rates, register catalogue `regs:[{n,g,a}]` |
| 0x02 | LOG | UTF-8 log line (ANSI colours included) |
| 0x03 | PARTITIONS | JSON: flash size, running/boot/next/last_invalid labels, `parts:[{l,t,st,o,s,enc,app?,state?}]` |
| 0x04 | OTADATA | JSON: both `esp_ota_select_entry_t` entries (seq, state, crc, crc_ok, raw hex), active entry, boot slot |
| 0x05 | TELEMETRY | JSON: heap (internal free, min, largest block, total), PSRAM, dropped frames, OTA bytes, app metrics `m:{}` |
| 0x06 | TASKS | JSON: FreeRTOS tasks with state, priority, core, stack high-water mark, run-time counter |
| 0x07 | REGS | JSON: `r:[[addr,value],…]` for the watch list |
| 0x08 | PCSAMPLES | binary: `core u8, n u8, period_us u16, n × pc u32` |
| 0x09 | OTA_EVENT | JSON with `ev`: begin, image_info, verify, end, set_boot, abort, error, reboot, boot, marked_valid, rollback |
| 0x0A | OTA_PROGRESS | JSON: part, addr, bytes written, image size, erased-to offset (10 Hz while writing) |
| 0x0B | ACK | JSON: `{seq, ok, err?, …}` |
| 0x0C | MEM | binary: `req_seq u16, space u8, addr u32, bytes` |
| 0x0D | CPU | JSON: per-core Xtensa special registers (PS, SAR, LBEG/LEND/LCOUNT, WINDOWBASE/START, CCOUNT, CCOMPARE0, INTENABLE, INTERRUPT, VECBASE, CPENABLE, PRID, EXCCAUSE, EXCVADDR, SP) |
| 0x0E | CRASH | JSON: core dump summary from the previous run (task, PC, EXCCAUSE, EXCVADDR, a0–a15, backtrace) |

## Host → device

| Type | Name | Payload |
| --- | --- | --- |
| 0x81 | HELLO | none. Device resends HELLO, PARTITIONS, OTADATA, boot event, CRASH |
| 0x82 | SET_RATES | JSON, Hz: `telemetry, regs, cpu, tasks, otadata, pc` (0 disables) |
| 0x83 | WATCH_REGS | JSON: `{reset?, clear?, add:[{name, addr, group?}]}`. Peripheral space `0x60000000–0x600D0FFC`, 4-byte aligned; FIFO registers are refused |
| 0x84 | READ_MEM | binary: `space u8 (0 flash, 1 RAM), addr u32, len u16 (≤ 2048)` |
| 0x85 | OTA_BEGIN | JSON: `{size}`. Writes into `esp_ota_get_next_update_partition()` |
| 0x86 | OTA_DATA | binary: `offset u32, bytes`. Offset must equal bytes written so far; ACK carries `w` |
| 0x87 | OTA_END | JSON: `{reboot}`. Validates, sets the boot partition, optionally reboots |
| 0x88 | OTA_ABORT | none |
| 0x89 | REBOOT | none |
| 0x8A | APP_STATE | JSON: `{action: "valid" \| "rollback"}` |

## Non-halting by design

Everything is read by the firmware itself. On the ESP32-S3, reading memory
over JTAG needs a CPU halt, and a halt mid-OTA stalls Wi-Fi and flash
operations. PC sampling uses the ASSIST_DEBUG block's PC recording: a task on
each core reads the other core's current PC.
