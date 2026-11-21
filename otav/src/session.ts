// Session state: everything the views draw, derived only from frames. Live
// connections and replays feed the same `apply`, so a replay at a given time
// shows exactly what was on screen live.

import { Frame, T, jsonOf, parseMem, parsePcSamples, textOf, MemReply } from './protocol';
import type { ElfSymbols } from './elf';

export interface AppDesc {
  proj: string;
  ver: string;
  idf: string;
  date: string;
  time: string;
  sha: string;
}

export interface Hello {
  proto: number;
  agent: string;
  chip: string;
  rev: number;
  cores: number;
  cpu_mhz: number;
  flash: number;
  psram: number;
  mac: string;
  reset: string;
  uptime_us: number;
  app: AppDesc;
  sec: { flash_enc: boolean; secure_boot: boolean };
  rates: Record<string, number>;
  regs: { n: string; g: string; a: number }[];
}

export interface Partition {
  l: string;
  t: number;
  st: number;
  o: number;
  s: number;
  enc: boolean;
  app?: AppDesc;
  state?: string;
}

export interface Partitions {
  flash: number;
  running: string | null;
  boot: string | null;
  next: string | null;
  last_invalid: string | null;
  parts: Partition[];
}

export interface OtadataEntry {
  seq: number;
  state: number;
  stn: string;
  crc: number;
  crc_ok: boolean;
  raw: string;
}

export interface Otadata {
  t: number;
  addr: number;
  slots: number;
  e: OtadataEntry[];
  active: number;
  boot_slot: number | null;
}

export interface OtaEvent {
  hostT: number; // ms since session start
  ev: string;
  d: any;
}

export interface OtaState {
  active: boolean;
  part: string;
  addr: number;
  partSize: number;
  image: number;
  written: number;
  erased: number;
  startHostT: number;
  endHostT: number | null;
  ok: boolean | null;
  info: any | null;
  rate: { hostT: number; bps: number }[];
}

export interface RegState {
  name: string;
  group: string;
  addr: number;
  value: number | null;
  prev: number | null;
  bitChangedAt: Float64Array; // host ms per bit, for the fade
  changes: number;
}

export interface TaskRow {
  n: string;
  id: number;
  s: number;
  p: number;
  c: number;
  hw: number;
  rt: number;
  cpu: number | null; // % over the last interval
}

export interface Series {
  t: number[];
  v: number[];
}

export interface LogLine {
  hostT: number;
  level: string;
  text: string;
}

const MAX_POINTS = 600;
const MAX_LOGS = 2000;
const PC_WINDOW = 3000;

export type Listener = () => void;

export class Session {
  t0 = 0;
  now = 0; // host ms since t0 of the latest frame
  version = 0;

  hello: Hello | null = null;
  partitions: Partitions | null = null;
  otadata: Otadata | null = null;
  otadataPrev: Otadata | null = null;
  otadataChangedAt = 0;
  crash: any | null = null;
  boot: any | null = null;
  ota: OtaState | null = null;
  otaEvents: OtaEvent[] = [];
  telemetry: any | null = null;
  series: Record<string, Series> = {};
  regs = new Map<number, RegState>();
  cpu: any[] = [];
  cpuPrev: any[] = [];
  tasks: TaskRow[] = [];
  private tasksPrev = new Map<number, number>();
  private tasksTotalPrev = 0;
  pc: { core: number; pcs: number[]; periodUs: number; total: number }[] = [];
  logs: LogLine[] = [];
  mem: MemReply | null = null;
  frames = 0;
  lastFrameAt = 0;
  elf: ElfSymbols | null = null;

  private listeners = new Set<Listener>();

  constructor() {
    this.reset();
  }

  reset(t0 = performance.now()) {
    const elf = this.elf;
    Object.assign(this, new SessionFields());
    this.elf = elf;
    this.t0 = t0;
    this.regs = new Map();
    this.tasksPrev = new Map();
    this.bump();
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  setElf(elf: ElfSymbols | null) {
    this.elf = elf;
    this.bump();
  }

  log(level: string, text: string, hostT = this.now) {
    this.logs.push({ hostT, level, text });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  private push(name: string, t: number, v: number) {
    const s = (this.series[name] ??= { t: [], v: [] });
    s.t.push(t);
    s.v.push(v);
    if (s.t.length > MAX_POINTS) {
      s.t.shift();
      s.v.shift();
    }
  }

  /** Applies one frame received at `hostT` ms since session start. */
  apply(f: Frame, hostT: number) {
    this.now = hostT;
    this.frames++;
    this.lastFrameAt = hostT;
    switch (f.type) {
      case T.HELLO: {
        const h = jsonOf<Hello>(f.payload);
        if (!h) break;
        this.hello = h;
        // Rebuild the register table, keeping history for known addresses.
        const next = new Map<number, RegState>();
        for (const r of h.regs) {
          next.set(
            r.a,
            this.regs.get(r.a) ?? {
              name: r.n,
              group: r.g,
              addr: r.a,
              value: null,
              prev: null,
              bitChangedAt: new Float64Array(32).fill(-1e9),
              changes: 0,
            },
          );
        }
        this.regs = next;
        break;
      }
      case T.LOG: {
        const raw = textOf(f.payload);
        const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
        const m = /^([EWIDV]) \(/.exec(text);
        this.log(m ? m[1] : 'I', text, hostT);
        break;
      }
      case T.PARTITIONS:
        this.partitions = jsonOf<Partitions>(f.payload);
        break;
      case T.OTADATA: {
        const o = jsonOf<Otadata>(f.payload);
        if (!o) break;
        const changed =
          this.otadata && this.otadata.e.map((e) => e.raw).join() !== o.e.map((e) => e.raw).join();
        if (changed) {
          this.otadataPrev = this.otadata;
          this.otadataChangedAt = hostT;
          this.log('I', `[otav] otadata changed: active entry ${o.active}, boot slot ${o.boot_slot}`, hostT);
        }
        this.otadata = o;
        break;
      }
      case T.TELEMETRY: {
        const tm = jsonOf<any>(f.payload);
        if (!tm) break;
        this.telemetry = tm;
        this.push('heap', hostT, tm.heap);
        this.push('psram', hostT, tm.psram);
        this.push('drops', hostT, tm.drops);
        for (const [k, v] of Object.entries(tm.m ?? {})) this.push(`m.${k}`, hostT, v as number);
        break;
      }
      case T.TASKS: {
        const tk = jsonOf<any>(f.payload);
        if (!tk) break;
        const dTotal = tk.total - this.tasksTotalPrev;
        const rows: TaskRow[] = tk.tasks.map((t: any) => {
          const prev = this.tasksPrev.get(t.id);
          // Run time is summed over both cores, so a task can reach 100% of one
          // core = 50% of the total; show it per core.
          const cpu =
            prev !== undefined && dTotal > 0
              ? Math.min(100, ((t.rt - prev) / dTotal) * 100 * (this.hello?.cores ?? 2))
              : null;
          return { ...t, cpu };
        });
        this.tasksPrev = new Map(tk.tasks.map((t: any) => [t.id, t.rt]));
        this.tasksTotalPrev = tk.total;
        rows.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || a.n.localeCompare(b.n));
        this.tasks = rows;
        break;
      }
      case T.REGS: {
        const r = jsonOf<{ t: number; r: [number, number][] }>(f.payload);
        if (!r) break;
        for (const [addr, val] of r.r) {
          let st = this.regs.get(addr);
          if (!st) {
            st = {
              name: `0x${addr.toString(16)}`,
              group: 'user',
              addr,
              value: null,
              prev: null,
              bitChangedAt: new Float64Array(32).fill(-1e9),
              changes: 0,
            };
            this.regs.set(addr, st);
          }
          const v = val >>> 0;
          if (st.value !== null && st.value !== v) {
            const diff = (st.value ^ v) >>> 0;
            for (let b = 0; b < 32; b++) if (diff & (1 << b)) st.bitChangedAt[b] = hostT;
            st.changes++;
            st.prev = st.value;
          }
          st.value = v;
        }
        break;
      }
      case T.CPU: {
        const c = jsonOf<any>(f.payload);
        if (!c) break;
        this.cpuPrev = this.cpu;
        this.cpu = c.cores;
        break;
      }
      case T.PCSAMPLES: {
        const s = parsePcSamples(f.payload);
        if (!s) break;
        const slot = (this.pc[s.core] ??= { core: s.core, pcs: [], periodUs: s.periodUs, total: 0 });
        slot.periodUs = s.periodUs;
        slot.total += s.pcs.length;
        for (const pc of s.pcs) slot.pcs.push(pc);
        if (slot.pcs.length > PC_WINDOW) slot.pcs.splice(0, slot.pcs.length - PC_WINDOW);
        break;
      }
      case T.OTA_EVENT: {
        const e = jsonOf<any>(f.payload);
        if (!e) break;
        this.otaEvents.push({ hostT, ev: e.ev, d: e });
        this.onOtaEvent(e, hostT);
        break;
      }
      case T.OTA_PROGRESS: {
        const p = jsonOf<any>(f.payload);
        if (!p) break;
        const o = this.ota;
        if (!o) break;
        const dt = hostT - (o.rate.length ? o.rate[o.rate.length - 1].hostT : o.startHostT);
        const dw = p.w - o.written;
        o.written = p.w;
        o.erased = p.erased;
        o.image = p.tot;
        if (dt > 0) o.rate.push({ hostT, bps: (dw / dt) * 1000 });
        this.push('ota_bps', hostT, dt > 0 ? (dw / dt) * 1000 : 0);
        break;
      }
      case T.MEM:
        this.mem = parseMem(f.payload);
        break;
      case T.CRASH:
        this.crash = jsonOf(f.payload);
        break;
      case T.ACK:
        break;
    }
    this.bump();
  }

  private onOtaEvent(e: any, hostT: number) {
    switch (e.ev) {
      case 'begin':
        this.ota = {
          active: true,
          part: e.part,
          addr: e.addr,
          partSize: e.size,
          image: e.image,
          written: 0,
          erased: 0,
          startHostT: hostT,
          endHostT: null,
          ok: null,
          info: null,
          rate: [],
        };
        this.series['ota_bps'] = { t: [], v: [] };
        break;
      case 'image_info':
        if (this.ota) this.ota.info = e;
        break;
      case 'end':
        if (this.ota) {
          this.ota.active = false;
          this.ota.ok = e.ok;
          this.ota.endHostT = hostT;
          this.ota.written = e.bytes;
          this.ota.erased = Math.ceil(e.bytes / 4096) * 4096;
        }
        break;
      case 'abort':
      case 'error':
        if (this.ota) {
          this.ota.active = false;
          this.ota.ok = false;
          this.ota.endHostT = hostT;
        }
        break;
      case 'boot':
        this.boot = e;
        break;
      case 'marked_valid':
        if (this.boot) this.boot = { ...this.boot, state: 'valid', valid_in_ms: 0 };
        break;
    }
  }
}

// Plain field defaults, so `reset` can restore them in one assignment.
class SessionFields {
  now = 0;
  hello = null;
  partitions = null;
  otadata = null;
  otadataPrev = null;
  otadataChangedAt = 0;
  crash = null;
  boot = null;
  ota = null;
  otaEvents = [];
  telemetry = null;
  series = {};
  cpu = [];
  cpuPrev = [];
  tasks = [];
  tasksTotalPrev = 0;
  pc = [];
  logs = [];
  mem = null;
  frames = 0;
  lastFrameAt = 0;
}
