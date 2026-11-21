// Recording and replay.
//
// A recording is JSON Lines: one header line, then one line per frame in
// either direction with its host time in ms. Frames are stored raw (base64
// payload), so a replay goes through the same Session.apply as a live run and
// stays faithful even after the views change.

import { Frame } from './protocol';
import { Session } from './session';

export interface RecFrame {
  t: number;
  d: 'rx' | 'tx';
  ty: number;
  s: number;
  p: string; // base64
}

export interface RecHeader {
  otav: 1;
  started: string;
  source: string;
  note?: string;
}

export class Recorder {
  header: RecHeader | null = null;
  frames: RecFrame[] = [];

  start(source: string) {
    this.header = { otav: 1, started: new Date().toISOString(), source };
    this.frames = [];
  }

  add(t: number, d: 'rx' | 'tx', f: Frame) {
    if (!this.header) this.start('unknown');
    this.frames.push({ t: Math.round(t * 10) / 10, d, ty: f.type, s: f.seq, p: b64(f.payload) });
  }

  clear() {
    this.header = null;
    this.frames = [];
  }

  toBlob(): Blob {
    const lines = [JSON.stringify(this.header), ...this.frames.map((f) => JSON.stringify(f))];
    return new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
  }

  get durationMs() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }
}

export function parseRecording(text: string): { header: RecHeader; frames: RecFrame[] } {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) throw new Error('empty recording');
  const header = JSON.parse(lines[0]) as RecHeader;
  if (header.otav !== 1) throw new Error('not an OTAV recording');
  const frames = lines.slice(1).map((l) => JSON.parse(l) as RecFrame);
  return { header, frames };
}

export const toFrame = (r: RecFrame): Frame => ({ type: r.ty, seq: r.s, payload: unb64(r.p) });

/** Plays a recording into a session; seeking rebuilds state from the start. */
export class Player {
  pos = 0; // host ms
  speed = 1;
  playing = false;
  private idx = 0;
  private raf = 0;
  private lastWall = 0;

  constructor(
    readonly session: Session,
    readonly header: RecHeader,
    readonly frames: RecFrame[],
  ) {
    this.seek(0);
  }

  get duration() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }

  seek(t: number) {
    this.session.reset(0);
    this.idx = 0;
    this.pos = Math.max(0, Math.min(t, this.duration));
    this.advanceTo(this.pos);
  }

  private advanceTo(t: number) {
    while (this.idx < this.frames.length && this.frames[this.idx].t <= t) {
      const f = this.frames[this.idx++];
      if (f.d === 'rx') this.session.apply(toFrame(f), f.t);
    }
    this.session.now = t;
    this.session.bump();
  }

  play() {
    if (this.playing) return;
    if (this.pos >= this.duration) this.seek(0);
    this.playing = true;
    this.lastWall = performance.now();
    const tick = () => {
      if (!this.playing) return;
      const now = performance.now();
      this.pos = Math.min(this.duration, this.pos + (now - this.lastWall) * this.speed);
      this.lastWall = now;
      this.advanceTo(this.pos);
      if (this.pos >= this.duration) {
        this.playing = false;
        this.session.bump();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.session.bump();
  }
}

function b64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
