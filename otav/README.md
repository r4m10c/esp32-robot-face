# OTAV web app

Local-first web app that shows what the robot-face firmware is doing while an
OTA update runs: the flash map and a 4 KB sector grid filling in, both otadata
entries flipping, the boot and mark-valid sequence, peripheral registers bit
by bit, per-core CPU special registers, sampled program counters, tasks, heap
and logs. Every session can be saved and replayed.

Protocol: [../docs/otav-protocol.md](../docs/otav-protocol.md).

## Run

```bash
cd otav
npm install
npm run dev        # http://localhost:5173
```

Use Chrome, Edge or Opera on desktop (WebSerial). `localhost` counts as a
secure context, so no HTTPS is needed.

- **Connect board**: pick the `USB JTAG/serial debug unit` port. The board
  must run firmware with the OTAV agent (flash it once with `idf.py flash`).
- **Simulator**: a fake board speaking the same protocol, for working on the
  UI without hardware.
- **Send OTA over USB**: choose `build/robot_face.bin`. Tick "reboot after"
  to watch the reboot, PENDING_VERIFY and the automatic mark-valid (15 s,
  `CONFIG_OTAV_MARK_VALID_AFTER_MS`). "Roll back" marks the running image
  invalid and reboots into the previous one.
- **Load .elf**: `build/robot_face.elf` turns sampled PCs and crash
  backtraces into function names, and is checked against the running app's
  SHA-256.
- **Save recording / Open recording**: `.otav.jsonl`, one frame per line.
  Replay has play, pause, speed and a scrubber.

After a reboot the USB device re-enumerates; the app reopens the
already-granted port by itself and keeps the timeline going.

## Test

```bash
npm test           # protocol, firmware interop, simulated OTA + replay
npm run build      # type-check and production build
```
