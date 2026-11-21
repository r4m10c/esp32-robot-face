import { describe, expect, it } from 'vitest';
import { linkRates } from './session';

describe('linkRates', () => {
  it('turns cumulative agent counters into per-second rates on the device clock', () => {
    const tx = (tel: number, regs: number) => Object.assign(new Array(16).fill(0), { 5: tel, 7: regs });
    const a = { t: 1_000_000, link: { full: 10, stall: 0, big: 0, bytes: 1000, tx: tx(100, 100), lost: new Array(16).fill(0) } };
    const lost = new Array(16).fill(0);
    lost[7] = 4;
    const b = { t: 3_000_000, link: { full: 14, stall: 0, big: 0, bytes: 41000, tx: tx(120, 116), lost } };
    const r = linkRates(a, b);
    expect(r.sent).toEqual({ telemetry: 10, regs: 8 });
    expect(r.lost).toEqual({ regs: 2 });
    expect(r.full).toBe(2);
    expect(r.bytesPerSec).toBe(20000);
  });
});
