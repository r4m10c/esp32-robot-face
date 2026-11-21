// Byte transports. The device controller only sees `write` and the two
// callbacks, so USB, the simulator and any future bridge (OpenOCD, probe-rs)
// plug in the same way.

export interface TransportEvents {
  onBytes: (b: Uint8Array) => void;
  onClose: (reason: string) => void;
}

export interface Transport {
  readonly kind: 'serial' | 'sim';
  readonly label: string;
  write(b: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Espressif's USB vendor id; the S3's USB Serial/JTAG enumerates as 303a:1001. */
export const ESPRESSIF_VID = 0x303a;

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class WebSerialTransport implements Transport {
  readonly kind = 'serial' as const;
  label = 'USB';
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private closing = false;

  private constructor(
    readonly port: SerialPort,
    private ev: TransportEvents,
  ) {
    const info = port.getInfo();
    this.label = `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId)}`;
  }

  /** Asks the user to pick a port (needs a user gesture). */
  static async request(ev: TransportEvents): Promise<WebSerialTransport> {
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
    return WebSerialTransport.open(port, ev);
  }

  /** Re-opens a port the user already granted, e.g. after the board reboots. */
  static async reopenKnown(ev: TransportEvents): Promise<WebSerialTransport | null> {
    const ports = await navigator.serial.getPorts();
    const port = ports.find((p) => p.getInfo().usbVendorId === ESPRESSIF_VID);
    return port ? WebSerialTransport.open(port, ev) : null;
  }

  static async open(port: SerialPort, ev: TransportEvents): Promise<WebSerialTransport> {
    // The baud rate is ignored by USB Serial/JTAG but required by the API.
    await port.open({ baudRate: 115200, bufferSize: 1 << 16 });
    // On this port RTS=1 with DTR=0 resets the chip. Drive both low together
    // so the line state never passes through that combination.
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      /* some platforms refuse; harmless */
    }
    const t = new WebSerialTransport(port, ev);
    t.pump();
    return t;
  }

  private async pump() {
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.ev.onBytes(value);
        }
      } catch (e) {
        // A reboot or unplug lands here (NetworkError: device lost).
        if (!this.closing) {
          this.ev.onClose(String(e));
          return;
        }
      } finally {
        this.reader.releaseLock();
      }
    }
    if (!this.closing) this.ev.onClose('port closed');
  }

  async write(b: Uint8Array) {
    if (!this.port.writable) throw new Error('port not writable');
    const w = this.port.writable.getWriter();
    try {
      await w.write(b);
    } finally {
      w.releaseLock();
    }
  }

  async close() {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    try {
      await this.port.close();
    } catch {
      /* already closed */
    }
  }
}

const hex4 = (n?: number) => (n ?? 0).toString(16).padStart(4, '0');
