import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, T, encodeFrame } from './protocol';

// fixtures/c_frames.txt is the output of the firmware's own encoder
// (components/otav_agent/test/host_frame_test.c). Regenerate it there if the
// wire format changes; this test keeps the two implementations in step.
const lines = readFileSync(new URL('./fixtures/c_frames.txt', import.meta.url), 'utf8').trim().split('\n');
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('firmware interop', () => {
  const big = new Uint8Array(600).map((_, i) => i % 256);

  it('JS encodes byte-for-byte what the firmware encodes', () => {
    expect(hexOf(encodeFrame(T.LOG, 0, new TextEncoder().encode('hello')))).toBe(lines[0]);
    expect(hexOf(encodeFrame(T.MEM, 1, big))).toBe(lines[1]);
  });

  it('JS decodes the firmware frames', () => {
    const d = new FrameDecoder();
    const out = d.push(unhex(lines.join('')));
    expect(out.map((f) => [f.type, f.seq])).toEqual([
      [T.LOG, 0],
      [T.MEM, 1],
    ]);
    expect([...out[1].payload]).toEqual([...big]);
  });
});
