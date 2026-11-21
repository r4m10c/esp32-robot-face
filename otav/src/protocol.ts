// OTAV wire format. Mirrors components/otav_agent/otav_priv.h and
// docs/otav-protocol.md; keep the three in step.
//
// Frame = COBS( type u8 | seq u16 LE | payload | crc32 LE ), delimited by 0x00.

export const PROTO_VERSION = 1;

export const T = {
  HELLO: 0x01,
  LOG: 0x02,
  PARTITIONS: 0x03,
  OTADATA: 0x04,
  TELEMETRY: 0x05,
  TASKS: 0x06,
  REGS: 0x07,
  PCSAMPLES: 0x08,
  OTA_EVENT: 0x09,
  OTA_PROGRESS: 0x0a,
  ACK: 0x0b,
  MEM: 0x0c,
  CPU: 0x0d,
  CRASH: 0x0e,
} as const;

export const C = {
  HELLO: 0x81,
  SET_RATES: 0x82,
  WATCH_REGS: 0x83,
  READ_MEM: 0x84,
  OTA_BEGIN: 0x85,
  OTA_DATA: 0x86,
  OTA_END: 0x87,
  OTA_ABORT: 0x88,
  REBOOT: 0x89,
  APP_STATE: 0x8a,
} as const;

export const TYPE_NAMES: Record<number, string> = Object.fromEntries([
  ...Object.entries(T).map(([k, v]) => [v, k]),
  ...Object.entries(C).map(([k, v]) => [v, k]),
]);

// --- CRC-32 (zlib / IEEE 802.3), same as esp_rom_crc32_le(0, ...) ---------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib-style CRC-32; pass the previous result as `crc` to chain. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// --- COBS -----------------------------------------------------------------

export function cobsEncode(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length + Math.ceil(input.length / 254) + 1);
  let codeAt = 0;
  let pos = 1;
  let code = 1;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (b === 0) {
      out[codeAt] = code;
      codeAt = pos++;
      code = 1;
      continue;
    }
    out[pos++] = b;
    if (++code === 0xff) {
      out[codeAt] = code;
      codeAt = pos++;
      code = 1;
    }
  }
  out[codeAt] = code;
  return out.subarray(0, pos);
}

export function cobsDecode(input: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(input.length);
  let i = 0;
  let o = 0;
  while (i < input.length) {
    const code = input[i++];
    if (code === 0) return null;
    for (let k = 1; k < code; k++) {
      if (i >= input.length) return null;
      out[o++] = input[i++];
    }
    if (code !== 0xff && i < input.length) out[o++] = 0;
  }
  return out.subarray(0, o);
}

// --- frames ---------------------------------------------------------------

export interface Frame {
  type: number;
  seq: number;
  payload: Uint8Array;
}

/** Encodes one frame, including the leading and trailing 0x00 delimiters. */
export function encodeFrame(type: number, seq: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const raw = new Uint8Array(3 + payload.length + 4);
  raw[0] = type;
  raw[1] = seq & 0xff;
  raw[2] = (seq >> 8) & 0xff;
  raw.set(payload, 3);
  const crc = crc32(raw.subarray(0, 3 + payload.length));
  new DataView(raw.buffer).setUint32(3 + payload.length, crc, true);
  const enc = cobsEncode(raw);
  const out = new Uint8Array(enc.length + 2);
  out.set(enc, 1);
  return out;
}

/** Parses one decoded (un-COBSed) frame; null if too short or the CRC fails. */
export function parseRaw(raw: Uint8Array): Frame | null {
  if (raw.length < 7) return null;
  const body = raw.subarray(0, raw.length - 4);
  const want = new DataView(raw.buffer, raw.byteOffset + raw.length - 4, 4).getUint32(0, true);
  if (crc32(body) !== want) return null;
  return { type: raw[0], seq: raw[1] | (raw[2] << 8), payload: raw.slice(3, raw.length - 4) };
}

/** Streaming decoder: feed it bytes as they arrive, get whole frames back. */
export class FrameDecoder {
  private buf = new Uint8Array(16384);
  private len = 0;
  private overflow = false;
  badFrames = 0;
  /** Bytes outside any frame (e.g. ROM boot text before the agent starts). */
  onNoise?: (text: string) => void;

  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b !== 0) {
        if (this.len < this.buf.length) this.buf[this.len++] = b;
        else this.overflow = true;
        continue;
      }
      if (this.len > 0 && !this.overflow) {
        const enc = this.buf.subarray(0, this.len);
        const raw = cobsDecode(enc);
        const f = raw ? parseRaw(raw) : null;
        if (f) {
          frames.push(f);
        } else {
          this.badFrames++;
          this.onNoise?.(printable(enc));
        }
      }
      this.len = 0;
      this.overflow = false;
    }
    return frames;
  }
}

function printable(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += c === 10 || c === 13 || (c >= 32 && c < 127) ? String.fromCharCode(c) : '';
  return s;
}

const te = new TextEncoder();
const td = new TextDecoder();

export const jsonPayload = (o: unknown) => te.encode(JSON.stringify(o));
export const textOf = (p: Uint8Array) => td.decode(p);
export function jsonOf<T = any>(p: Uint8Array): T | null {
  try {
    return JSON.parse(td.decode(p)) as T;
  } catch {
    return null;
  }
}

// --- binary payloads ------------------------------------------------------

export interface PcSamples {
  core: number;
  periodUs: number;
  pcs: Uint32Array;
}

export function parsePcSamples(p: Uint8Array): PcSamples | null {
  if (p.length < 4) return null;
  const n = p[1];
  if (p.length < 4 + 4 * n) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const pcs = new Uint32Array(n);
  for (let i = 0; i < n; i++) pcs[i] = dv.getUint32(4 + 4 * i, true);
  return { core: p[0], periodUs: p[2] | (p[3] << 8), pcs };
}

export interface MemReply {
  reqSeq: number;
  space: number;
  addr: number;
  data: Uint8Array;
}

export function parseMem(p: Uint8Array): MemReply | null {
  if (p.length < 7) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return { reqSeq: dv.getUint16(0, true), space: p[2], addr: dv.getUint32(3, true), data: p.slice(7) };
}

export function readMemPayload(space: 0 | 1, addr: number, len: number): Uint8Array {
  const b = new Uint8Array(7);
  const dv = new DataView(b.buffer);
  b[0] = space;
  dv.setUint32(1, addr >>> 0, true);
  dv.setUint16(5, len, true);
  return b;
}

export function otaDataPayload(offset: number, data: Uint8Array): Uint8Array {
  const b = new Uint8Array(4 + data.length);
  new DataView(b.buffer).setUint32(0, offset >>> 0, true);
  b.set(data, 4);
  return b;
}
