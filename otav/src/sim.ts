// A simulated ESP32-S3 running the OTAV agent, speaking the real wire
// protocol. Lets the web app be developed, demoed and tested without a board,
// including a full USB OTA, reboot, PENDING_VERIFY and rollback. Values are
// plausible, not measured.

import { C, FrameDecoder, T, crc32, encodeFrame, jsonOf } from './protocol';
import { Transport, TransportEvents } from './transport';

const KB = 1024;
const MB = 1024 * KB;

const PARTS = [
  { l: 'nvs', t: 1, st: 2, o: 0x9000, s: 0x6000 },
  { l: 'otadata', t: 1, st: 0, o: 0xf000, s: 0x2000 },
  { l: 'phy_init', t: 1, st: 1, o: 0x11000, s: 0x1000 },
  { l: 'coredump', t: 1, st: 3, o: 0x12000, s: 0x10000 },
  { l: 'ota_0', t: 0, st: 0x10, o: 0x30000, s: 0x400000 },
  { l: 'ota_1', t: 0, st: 0x11, o: 0x430000, s: 0x400000 },
  { l: 'storage', t: 1, st: 0x82, o: 0x830000, s: 0x7d0000 },
];

const REGS = [
  { n: 'SPI_MEM_CMD_REG(1)', g: 'flash', a: 0x60002000 },
  { n: 'SPI_MEM_CMD_REG(0)', g: 'flash', a: 0x60003000 },
  { n: 'SPI_MEM_CLOCK_REG(0)', g: 'flash', a: 0x60003014 },
  { n: 'EXTMEM_ICACHE_CTRL_REG', g: 'cache', a: 0x600c4060 },
  { n: 'EXTMEM_DCACHE_CTRL_REG', g: 'cache', a: 0x600c4000 },
  { n: 'TIMG_WDTCONFIG0_REG(0)', g: 'wdt', a: 0x6001f048 },
  { n: 'TIMG_WDTCONFIG0_REG(1)', g: 'wdt', a: 0x60020048 },
  { n: 'RTC_CNTL_WDTCONFIG0_REG', g: 'wdt', a: 0x60008098 },
  { n: 'RTC_CNTL_RESET_STATE_REG', g: 'reset', a: 0x60008038 },
  { n: 'SYSTEM_CPU_PER_CONF_REG', g: 'clock', a: 0x600c0010 },
  { n: 'SPI_CMD_REG(2)', g: 'display', a: 0x60024000 },
  { n: 'SPI_CLOCK_REG(2)', g: 'display', a: 0x6002400c },
  { n: 'USB_SERIAL_JTAG_FRAM_NUM_REG', g: 'usb', a: 0x60038024 },
];

// Fake code regions so the PC profile has shape (no ELF needed for the sim).
const HOT = [
  { a: 0x42010400, w: 0.34 }, // render loop
  { a: 0x42013a00, w: 0.12 }, // scanline fill
  { a: 0x40378100, w: 0.3 }, // idle / waiti
  { a: 0x4037c200, w: 0.08 }, // flash ops (IRAM)
  { a: 0x42020800, w: 0.06 }, // agent
  { a: 0x40380a00, w: 0.1 }, // FreeRTOS
];

const STATE = { new: 0, pending_verify: 1, valid: 2, invalid: 3, aborted: 4 } as const;
type StateName = keyof typeof STATE;

interface AppImage {
  proj: string;
  ver: string;
  idf: string;
  date: string;
  time: string;
  sha: string;
}

export class SimTransport implements Transport {
  readonly kind = 'sim' as const;
  readonly label = 'Simulator';
  private decoder = new FrameDecoder();
  private seq = 0;
  private timers: number[] = [];
  private bootUs = performance.now() * 1000;
  private rates: Record<string, number> = { telemetry: 10, regs: 10, cpu: 2, tasks: 1, otadata: 1, pc: 500 };
  private running = 'ota_0';
  private apps: Record<string, AppImage | null> = {
    ota_0: { proj: 'robot_face', ver: 'v1.0.0', idf: 'v5.5.1', date: 'Nov 21 2026', time: '20:14:02', sha: 'a1b2c3d4e5f60718' },
    ota_1: null,
  };
  private states: Record<string, StateName> = { ota_0: 'valid' };
  private otadata = [this.entry(1, 'valid'), this.blankEntry()];
  private ota: { part: string; size: number; w: number; header: Uint8Array; lastReport: number; t0: number } | null =
    null;
  private regVals = new Map<number, number>();
  private flashBusyUntil = 0;
  private frame = 0;
  private runtime = new Map<string, number>();
  private validTimer = 0;
  private logTimer = 0;
  private fps = 41;

  constructor(private ev: TransportEvents) {
    this.initRegs();
    this.startPeriodic();
    setTimeout(() => {
      this.log('I', 'bloub_face', 'Bloub starting');
      this.log('I', 'otav', 'agent 0.1.0 up (protocol 1)');
    }, 50);
  }

  // --- wire --------------------------------------------------------------

  async write(b: Uint8Array) {
    for (const f of this.decoder.push(b)) this.onCommand(f.type, f.seq, f.payload);
  }

  async close() {
    this.timers.forEach((t) => clearInterval(t));
    clearTimeout(this.validTimer);
    clearTimeout(this.logTimer);
  }

  private send(type: number, payload: Uint8Array | object) {
    const p = payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
    const f = encodeFrame(type, this.seq++ & 0xffff, p);
    // Deliver asynchronously, like a real port.
    queueMicrotask(() => this.ev.onBytes(f));
  }

  private ack(seq: number, ok: boolean, extra: object = {}, err?: string) {
    this.send(T.ACK, { seq, ok, ...(err ? { err } : {}), ...extra });
  }

  private us() {
    return Math.round(performance.now() * 1000 - this.bootUs);
  }

  private log(level: string, tag: string, msg: string) {
    this.send(T.LOG, new TextEncoder().encode(`${level} (${Math.round(this.us() / 1000)}) ${tag}: ${msg}`));
  }

  // --- model -------------------------------------------------------------

  private entry(seq: number, state: StateName) {
    const b = new Uint8Array(32).fill(0xff);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, seq, true);
    dv.setUint32(24, STATE[state], true);
    dv.setUint32(28, crc32(b.subarray(0, 4), 0xffffffff), true);
    return b;
  }

  private blankEntry() {
    return new Uint8Array(32).fill(0xff);
  }

  private initRegs() {
    const set = (a: number, v: number) => this.regVals.set(a, v >>> 0);
    set(0x60002000, 0);
    set(0x60003000, 0);
    set(0x60003014, 0x00030103);
    set(0x600c4060, 0b0101);
    set(0x600c4000, 0b01101);
    set(0x6001f048, (1 << 31) | (3 << 29) | (1 << 18) | (1 << 15));
    set(0x60020048, (1 << 31) | (1 << 29) | (3 << 27) | (1 << 18) | (1 << 15));
    set(0x60008098, (1 << 31) | (5 << 28) | (1 << 12) | (1 << 9) | 20);
    set(0x60008038, (1 << 13) | (1 << 12) | (1 << 6) | 1);
    set(0x600c0010, 0b0110);
    set(0x60024000, 0);
    set(0x6002400c, (1 << 31) | 0x3043);
    set(0x60038024, 0);
  }

  private partsJson() {
    const nextSlot = this.running === 'ota_0' ? 'ota_1' : 'ota_0';
    const active = this.activeEntry();
    const bootPart = active >= 0 ? `ota_${(this.seqOf(active) - 1) % 2}` : 'ota_0';
    return {
      flash: 16 * MB,
      running: this.running,
      boot: bootPart,
      next: nextSlot,
      last_invalid: Object.entries(this.states).find(([, s]) => s === 'invalid' || s === 'aborted')?.[0] ?? null,
      parts: PARTS.map((p) => ({
        ...p,
        enc: false,
        ...(p.t === 0 && this.apps[p.l] ? { app: this.apps[p.l], state: this.states[p.l] ?? 'undefined' } : {}),
      })),
    };
  }

  private seqOf(i: number) {
    return new DataView(this.otadata[i].buffer).getUint32(0, true);
  }

  private stateOf(i: number) {
    return new DataView(this.otadata[i].buffer).getUint32(24, true);
  }

  private crcOk(i: number) {
    const dv = new DataView(this.otadata[i].buffer);
    return dv.getUint32(0, true) !== 0xffffffff && crc32(this.otadata[i].subarray(0, 4), 0xffffffff) === dv.getUint32(28, true);
  }

  private activeEntry() {
    let best = -1;
    for (let i = 0; i < 2; i++) {
      const st = this.stateOf(i);
      if (this.crcOk(i) && st !== 3 && st !== 4 && (best < 0 || this.seqOf(i) > this.seqOf(best))) best = i;
    }
    return best;
  }

  private otadataJson() {
    const names = ['new', 'pending_verify', 'valid', 'invalid', 'aborted'];
    const active = this.activeEntry();
    return {
      t: this.us(),
      addr: 0xf000,
      slots: 2,
      e: [0, 1].map((i) => {
        const st = this.stateOf(i);
        return {
          seq: this.seqOf(i),
          state: st,
          stn: st === 0xffffffff ? 'undefined' : names[st] ?? 'unknown',
          crc: new DataView(this.otadata[i].buffer).getUint32(28, true),
          crc_ok: this.crcOk(i),
          raw: [...this.otadata[i]].map((b) => b.toString(16).padStart(2, '0')).join(''),
        };
      }),
      active,
      boot_slot: active >= 0 ? (this.seqOf(active) - 1) % 2 : null,
    };
  }

  private hello() {
    return {
      proto: 1,
      agent: '0.1.0 (sim)',
      chip: 'esp32s3',
      rev: 2,
      cores: 2,
      cpu_mhz: 240,
      flash: 16 * MB,
      psram: 8 * MB,
      mac: 'de:ad:be:ef:00:01',
      reset: this.resetReason,
      uptime_us: this.us(),
      app: this.apps[this.running],
      sec: { flash_enc: false, secure_boot: false },
      rates: this.rates,
      regs: REGS,
    };
  }

  private resetReason = 'poweron';

  private bootEvent() {
    const st = this.states[this.running] ?? 'valid';
    const remaining = this.validAt ? Math.max(0, this.validAt - performance.now()) : 0;
    return { t: this.us(), ev: 'boot', part: this.running, state: st, auto_valid_ms: 15000, valid_in_ms: Math.round(remaining) };
  }

  private validAt = 0;

  // --- commands ----------------------------------------------------------

  private onCommand(type: number, seq: number, p: Uint8Array) {
    const j = () => jsonOf<any>(p) ?? {};
    switch (type) {
      case C.HELLO:
        this.send(T.HELLO, this.hello());
        this.send(T.PARTITIONS, this.partsJson());
        this.send(T.OTADATA, this.otadataJson());
        this.send(T.OTA_EVENT, this.bootEvent());
        this.ack(seq, true);
        break;
      case C.SET_RATES:
        Object.assign(this.rates, j());
        this.restartPeriodic();
        this.ack(seq, true);
        this.send(T.HELLO, this.hello());
        break;
      case C.WATCH_REGS: {
        const r = j();
        for (const a of r.add ?? []) {
          REGS.push({ n: a.name, g: a.group ?? 'user', a: a.addr });
          this.regVals.set(a.addr, (Math.random() * 0xffffffff) >>> 0);
        }
        this.ack(seq, true);
        this.send(T.HELLO, this.hello());
        break;
      }
      case C.READ_MEM: {
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const space = p[0];
        const addr = dv.getUint32(1, true);
        const len = dv.getUint16(5, true);
        const data = new Uint8Array(len);
        if (space === 0 && addr >= 0xf000 && addr < 0x11000) {
          const sector = addr >= 0x10000 ? 1 : 0;
          const off = addr - 0xf000 - sector * 0x1000;
          data.fill(0xff);
          if (off < 32) data.set(this.otadata[sector].subarray(off, Math.min(32, off + len)), 0);
        } else {
          for (let i = 0; i < len; i++) data[i] = (addr + i * 37) & 0xff;
        }
        const out = new Uint8Array(7 + len);
        const odv = new DataView(out.buffer);
        odv.setUint16(0, seq, true);
        out[2] = space;
        odv.setUint32(3, addr, true);
        out.set(data, 7);
        this.send(T.MEM, out);
        this.ack(seq, true);
        break;
      }
      case C.OTA_BEGIN: {
        const size = j().size;
        const part = this.running === 'ota_0' ? 'ota_1' : 'ota_0';
        const pi = PARTS.find((x) => x.l === part)!;
        this.ota = { part, size, w: 0, header: new Uint8Array(288), lastReport: 0, t0: performance.now() };
        this.apps[part] = null;
        this.send(T.OTA_EVENT, { t: this.us(), ev: 'begin', src: 'usb', part, addr: pi.o, size: pi.s, image: size });
        this.log('I', 'otav_ota', `OTA begin from usb into ${part} (${size} bytes)`);
        this.ack(seq, true, { part, addr: pi.o });
        break;
      }
      case C.OTA_DATA: {
        const o = this.ota;
        if (!o) return this.ack(seq, false, {}, 'not_active');
        const off = new DataView(p.buffer, p.byteOffset).getUint32(0, true);
        if (off !== o.w) return this.ack(seq, false, { w: o.w }, 'offset');
        const data = p.subarray(4);
        if (o.w < 288) o.header.set(data.subarray(0, 288 - o.w), o.w);
        const crossesSector = Math.floor((o.w + data.length - 1) / 4096) > Math.floor((o.w - 1) / 4096) || o.w === 0;
        const delay = 8 + (crossesSector ? 22 : 0); // program + erase, ms
        this.flashBusyUntil = performance.now() + delay;
        setTimeout(() => {
          if (!this.ota) return;
          const before = o.w;
          o.w += data.length;
          if (before < 288 && o.w >= 288) this.sendImageInfo(o.header);
          if (performance.now() - o.lastReport > 100) {
            o.lastReport = performance.now();
            this.progress();
          }
          this.ack(seq, true, { w: o.w });
        }, delay);
        break;
      }
      case C.OTA_END: {
        const o = this.ota;
        if (!o) return this.ack(seq, false, {}, 'not_active');
        this.progress();
        this.send(T.OTA_EVENT, { t: this.us(), ev: 'verify', bytes: o.w });
        const reboot = !!j().reboot;
        setTimeout(() => {
          const ok = o.header[0] === 0xe9 && o.w === o.size;
          this.send(T.OTA_EVENT, {
            t: this.us(),
            ev: 'end',
            ok,
            err: ok ? 'ESP_OK' : 'ESP_ERR_OTA_VALIDATE_FAILED',
            bytes: o.w,
            write_ms: Math.round(performance.now() - o.t0),
            verify_ms: 180,
          });
          this.ota = null;
          if (!ok) return this.ack(seq, false, {}, 'ESP_ERR_OTA_VALIDATE_FAILED');
          const info = this.imageInfo(o.header);
          this.apps[o.part] = info;
          this.states[o.part] = 'new';
          // New otadata entry goes into the sector that is not active.
          const active = this.activeEntry();
          const seqNo = (active >= 0 ? this.seqOf(active) : 0) + 1;
          const target = active === 0 ? 1 : 0;
          // Choose a sequence number that selects the target slot.
          let s2 = seqNo;
          const slotIdx = o.part === 'ota_0' ? 0 : 1;
          while ((s2 - 1) % 2 !== slotIdx) s2++;
          this.otadata[target] = this.entry(s2, 'new');
          this.send(T.OTA_EVENT, { t: this.us(), ev: 'set_boot', part: o.part, ok: true, err: 'ESP_OK' });
          this.send(T.OTADATA, this.otadataJson());
          this.send(T.PARTITIONS, this.partsJson());
          this.ack(seq, true);
          if (reboot) this.reboot();
        }, 180);
        break;
      }
      case C.OTA_ABORT:
        if (this.ota) this.send(T.OTA_EVENT, { t: this.us(), ev: 'abort', reason: 'host', at: this.ota.w });
        this.ota = null;
        this.ack(seq, true);
        break;
      case C.REBOOT:
        this.ack(seq, true);
        this.reboot();
        break;
      case C.APP_STATE: {
        const action = j().action;
        if (action === 'valid') {
          this.markValid(false);
          this.ack(seq, true);
        } else if (action === 'rollback') {
          this.send(T.OTA_EVENT, { t: this.us(), ev: 'rollback' });
          this.ack(seq, true);
          const active = this.activeEntry();
          if (active >= 0) this.otadata[active] = this.entry(this.seqOf(active), 'invalid');
          this.states[this.running] = 'invalid';
          this.reboot();
        }
        break;
      }
      default:
        this.ack(seq, false, {}, 'unknown_command');
    }
  }

  private imageInfo(h: Uint8Array): AppImage {
    const td = new TextDecoder();
    const str = (o: number, n: number) => td.decode(h.subarray(o, o + n)).replace(/\0.*$/s, '') || '?';
    const desc = 32;
    const looksReal = new DataView(h.buffer).getUint32(desc, true) === 0xabcd5432;
    const sha = [...h.subarray(desc + 144, desc + 152)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return looksReal
      ? {
          proj: str(desc + 48, 32),
          ver: str(desc + 16, 32),
          idf: str(desc + 112, 32),
          date: str(desc + 96, 16),
          time: str(desc + 80, 16),
          sha,
        }
      : { proj: 'robot_face', ver: 'v1.1.0-sim', idf: 'v5.5.1', date: 'Nov 21 2026', time: '22:40:00', sha: 'ffeeddccbbaa9988' };
  }

  private sendImageInfo(h: Uint8Array) {
    const i = this.imageInfo(h);
    this.send(T.OTA_EVENT, {
      t: this.us(),
      ev: 'image_info',
      magic: h[0],
      segments: h[1],
      chip_id: h[12] | (h[13] << 8),
      entry: new DataView(h.buffer).getUint32(4, true),
      hash_appended: h[23],
      desc_ok: new DataView(h.buffer).getUint32(32, true) === 0xabcd5432,
      ...i,
    });
  }

  private progress() {
    const o = this.ota;
    if (!o) return;
    const pi = PARTS.find((x) => x.l === o.part)!;
    this.send(T.OTA_PROGRESS, {
      t: this.us(),
      part: o.part,
      addr: pi.o,
      w: o.w,
      tot: o.size,
      erased: Math.ceil(o.w / 4096) * 4096,
    });
  }

  private reboot() {
    this.send(T.OTA_EVENT, { t: this.us(), ev: 'reboot' });
    this.pause = true;
    setTimeout(() => {
      // Bootloader: pick the active otadata entry; NEW becomes PENDING_VERIFY.
      const active = this.activeEntry();
      const slot = active >= 0 ? (this.seqOf(active) - 1) % 2 : 0;
      const part = `ota_${slot}`;
      if (active >= 0 && this.stateOf(active) === STATE.new) {
        this.otadata[active] = this.entry(this.seqOf(active), 'pending_verify');
        this.states[part] = 'pending_verify';
      }
      this.running = this.apps[part] ? part : 'ota_0';
      this.bootUs = performance.now() * 1000;
      this.resetReason = 'software';
      this.runtime.clear();
      this.pause = false;
      this.log('I', 'boot', `Loaded app from partition at offset 0x${(part === 'ota_0' ? 0x30000 : 0x430000).toString(16)}`);
      this.log('I', 'bloub_face', 'Bloub starting');
      if (this.states[this.running] === 'pending_verify') {
        this.log('W', 'otav_ota', 'running image is PENDING_VERIFY; auto-marking valid after a healthy run');
        this.validAt = performance.now() + 15000;
        this.validTimer = globalThis.setTimeout(() => this.markValid(true), 15000);
      }
      this.send(T.HELLO, this.hello());
      this.send(T.PARTITIONS, this.partsJson());
      this.send(T.OTADATA, this.otadataJson());
      this.send(T.OTA_EVENT, this.bootEvent());
    }, 1800);
  }

  private pause = false;

  private markValid(auto: boolean) {
    clearTimeout(this.validTimer);
    this.validAt = 0;
    const active = this.activeEntry();
    if (active >= 0 && this.stateOf(active) === STATE.pending_verify) {
      this.otadata[active] = this.entry(this.seqOf(active), 'valid');
    }
    this.states[this.running] = 'valid';
    this.send(T.OTA_EVENT, { t: this.us(), ev: 'marked_valid', auto, ok: true });
    this.send(T.OTADATA, this.otadataJson());
    this.send(T.PARTITIONS, this.partsJson());
  }

  // --- periodic streams --------------------------------------------------

  private restartPeriodic() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.startPeriodic();
  }

  private every(hz: number, fn: () => void) {
    if (hz > 0) this.timers.push(globalThis.setInterval(() => !this.pause && fn(), 1000 / hz));
  }

  private startPeriodic() {
    this.every(this.rates.telemetry, () => this.telemetry());
    this.every(this.rates.regs, () => this.regs());
    this.every(this.rates.cpu, () => this.cpu());
    this.every(this.rates.tasks, () => this.tasks());
    this.every(this.rates.otadata, () => this.send(T.OTADATA, this.otadataJson()));
    if (this.rates.pc > 0) this.every(1000 / 64 / (1000 / this.rates.pc), () => this.pcBatch());
    const chatter = () => {
      if (!this.pause && Math.random() < 0.5) {
        const states = ['idle', 'thinking', 'wink', 'wide', 'orbit', 'comet'];
        this.log('I', 'bloub', `${this.fps.toFixed(1)} fps | ${states[(Math.random() * states.length) | 0]} | bands 4..25 | stamps 0`);
      }
      this.logTimer = globalThis.setTimeout(chatter, 2000);
    };
    clearTimeout(this.logTimer);
    this.logTimer = globalThis.setTimeout(chatter, 2000);
  }

  private telemetry() {
    const writing = !!this.ota;
    this.fps = writing ? 28 + Math.random() * 6 : 40 + Math.random() * 4;
    this.send(T.TELEMETRY, {
      t: this.us(),
      heap: Math.round(212000 - (writing ? 9000 : 0) - Math.random() * 1500),
      heap_min: 198000,
      heap_big: 110592,
      heap_tot: 360000,
      psram: 8 * MB - 2 * MB,
      psram_tot: 8 * MB,
      drops: 0,
      ota_w: this.ota?.w ?? 0,
      m: { fps: this.fps, bands: 22, stamps: 0 },
    });
  }

  private regs() {
    const busy = performance.now() < this.flashBusyUntil;
    const erase = busy && Math.random() < 0.4;
    this.regVals.set(0x60002000, busy ? (erase ? (1 << 24) | (1 << 30) : (1 << 25) | (1 << 30)) : 0);
    this.regVals.set(0x60024000, Math.random() < 0.7 ? (1 << 24) | 0x1f3f : 0x1f3f);
    this.frame = (this.frame + 100 + ((Math.random() * 3) | 0)) & 0x7ff;
    this.regVals.set(0x60038024, this.frame);
    this.send(T.REGS, { t: this.us(), r: REGS.map((r) => [r.a, this.regVals.get(r.a) ?? 0]) });
  }

  private cpu() {
    const ccount = Math.round((this.us() * 240) % 2 ** 32);
    const core = (c: number) => ({
      core: c,
      PS: 0x00060020,
      SAR: (Math.random() * 32) | 0,
      LBEG: 0x40056f5c,
      LEND: 0x40056f78,
      LCOUNT: 0,
      WINDOWBASE: (Math.random() * 16) | 0,
      WINDOWSTART: 1 << ((Math.random() * 16) | 0),
      CCOUNT: (ccount + c * 1234567) >>> 0,
      CCOMPARE0: (ccount + 240000) >>> 0,
      INTENABLE: c === 0 ? 0x0000ee4c : 0x00002240,
      INTERRUPT: Math.random() < 0.3 ? 0x40 : 0,
      VECBASE: 0x40374000,
      CPENABLE: Math.random() < 0.2 ? 1 : 0,
      PRID: c === 0 ? 0xcdcd : 0xabab,
      EXCCAUSE: 4,
      EXCVADDR: 0,
      SP: 0x3fcb0000 + c * 0x2000 + ((Math.random() * 64) | 0) * 16,
    });
    this.send(T.CPU, { t: this.us(), cores: [core(0), core(1)] });
  }

  private tasks() {
    const writing = !!this.ota;
    const list = [
      { n: 'main', p: 1, c: 0, hw: 2100, load: writing ? 0.55 : 0.7 },
      { n: 'IDLE0', p: 0, c: 0, hw: 820, load: writing ? 0.2 : 0.25 },
      { n: 'IDLE1', p: 0, c: 1, hw: 830, load: writing ? 0.6 : 0.96 },
      { n: 'otav_rx', p: 5, c: -1, hw: 3900, load: writing ? 0.32 : 0.001 },
      { n: 'otav_tx', p: 5, c: -1, hw: 1800, load: 0.01 },
      { n: 'otav_smp', p: 5, c: -1, hw: 2300, load: 0.02 },
      { n: 'otav_pc0', p: 22, c: 1, hw: 1500, load: 0.004 },
      { n: 'otav_pc1', p: 22, c: 0, hw: 1500, load: 0.004 },
      { n: 'esp_timer', p: 22, c: 0, hw: 3100, load: 0.01 },
      { n: 'ipc0', p: 24, c: 0, hw: 600, load: 0.001 },
      { n: 'ipc1', p: 24, c: 1, hw: 600, load: 0.001 },
    ];
    const total = this.us() * 2;
    let id = 1;
    this.send(T.TASKS, {
      t: this.us(),
      total,
      tasks: list.map((t) => {
        const prev = this.runtime.get(t.n) ?? 0;
        const rt = prev + Math.round((1e6 / this.rates.tasks) * t.load * (0.9 + Math.random() * 0.2));
        this.runtime.set(t.n, rt);
        return { n: t.n, id: id++, s: t.load > 0.5 ? 0 : 2, p: t.p, c: t.c, hw: t.hw, rt };
      }),
    });
  }

  private pcBatch() {
    for (const core of [0, 1]) {
      const b = new Uint8Array(4 + 64 * 4);
      const dv = new DataView(b.buffer);
      b[0] = core;
      b[1] = 64;
      dv.setUint16(2, Math.round(1e6 / this.rates.pc), true);
      for (let i = 0; i < 64; i++) {
        let r = Math.random();
        let pick = HOT[HOT.length - 1];
        const w = core === 1 ? [0.02, 0.01, 0.9, this.ota ? 0.05 : 0.0, 0.02, 0.05] : HOT.map((h) => h.w);
        const sum = w.reduce((a, c) => a + c, 0);
        r *= sum;
        for (let k = 0; k < HOT.length; k++) {
          if ((r -= w[k]) <= 0) {
            pick = HOT[k];
            break;
          }
        }
        dv.setUint32(4 + 4 * i, pick.a + (((Math.random() * 64) | 0) << 2), true);
      }
      this.send(T.PCSAMPLES, b);
    }
  }
}
