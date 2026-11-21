import { describe, expect, it } from 'vitest';
import { FrameDecoder, cobsDecode, cobsEncode, crc32, encodeFrame, parsePcSamples, T } from './protocol';

describe('crc32', () => {
  it('matches the zlib check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('chains like esp_rom_crc32_le', () => {
    const a = new TextEncoder().encode('1234');
    const b = new TextEncoder().encode('56789');
    expect(crc32(b, crc32(a))).toBe(0xcbf43926);
  });
  it('computes an otadata entry CRC the way the bootloader does', () => {
    // esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4) for ota_seq = 1
    const seq = new Uint8Array([1, 0, 0, 0]);
    // Reference: Python zlib.crc32(bytes([1, 0, 0, 0]), 0xffffffff)
    expect(crc32(seq, 0xffffffff)).toBe(0x4743989a);
  });
});

describe('cobs', () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([0, 0, 1, 0]),
    new Uint8Array(253).fill(7),
    new Uint8Array(254).fill(7),
    new Uint8Array(255).fill(7),
    new Uint8Array(1000).map((_, i) => i % 7),
  ];
  for (const c of cases) {
    it(`round-trips ${c.length} bytes`, () => {
      const enc = cobsEncode(c);
      expect(enc.includes(0)).toBe(false);
      expect([...cobsDecode(enc)!]).toEqual([...c]);
    });
  }
});

describe('frames', () => {
  it('decodes frames split across chunks, with noise between them', () => {
    const payload = new Uint8Array(4000).map((_, i) => i & 0xff);
    const f1 = encodeFrame(T.LOG, 1, new TextEncoder().encode('hello'));
    const f2 = encodeFrame(T.MEM, 2, payload);
    const noise = new TextEncoder().encode('ESP-ROM:esp32s3-20210327\r\n');
    const stream = new Uint8Array([...noise, ...f1, ...f2]);
    const d = new FrameDecoder();
    let noiseSeen = '';
    d.onNoise = (t) => (noiseSeen += t);
    const out = [];
    for (let i = 0; i < stream.length; i += 17) out.push(...d.push(stream.subarray(i, i + 17)));
    expect(out.map((f) => f.type)).toEqual([T.LOG, T.MEM]);
    expect(out[1].seq).toBe(2);
    expect([...out[1].payload]).toEqual([...payload]);
    expect(noiseSeen).toContain('ESP-ROM');
  });

  it('rejects a corrupted frame', () => {
    const f = encodeFrame(T.LOG, 9, new TextEncoder().encode('x'));
    f[3] ^= 0x40;
    const d = new FrameDecoder();
    expect(d.push(f)).toEqual([]);
    expect(d.badFrames).toBe(1);
  });

  it('parses PC samples', () => {
    const b = new Uint8Array(4 + 8);
    const dv = new DataView(b.buffer);
    b[0] = 1;
    b[1] = 2;
    dv.setUint16(2, 1000, true);
    dv.setUint32(4, 0x42001234, true);
    dv.setUint32(8, 0x40378000, true);
    const s = parsePcSamples(b)!;
    expect(s.core).toBe(1);
    expect(s.periodUs).toBe(1000);
    expect([...s.pcs]).toEqual([0x42001234, 0x40378000]);
  });
});
