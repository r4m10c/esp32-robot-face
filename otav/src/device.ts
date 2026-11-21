// Device controller: owns the transport, decodes frames into the session,
// records everything, and wraps host commands as promises resolved by ACKs.

import {
  C,
  Frame,
  FrameDecoder,
  T,
  encodeFrame,
  jsonOf,
  jsonPayload,
  otaDataPayload,
  readMemPayload,
} from './protocol';
import { Recorder } from './recording';
import { Session } from './session';
import { Transport, TransportEvents, WebSerialTransport } from './transport';
import { SimTransport } from './sim';

export type LinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'replay';

interface Pending {
  resolve: (a: any) => void;
  reject: (e: Error) => void;
  timer: number;
}

export const OTA_CHUNK = 4000;

export class Device {
  transport: Transport | null = null;
  state: LinkState = 'idle';
  error = '';
  private decoder = new FrameDecoder();
  private seq = 1;
  private pending = new Map<number, Pending>();
  private wantReconnect = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  otaSend: { sent: number; total: number; running: boolean; error?: string } | null = null;

  constructor(
    readonly session: Session,
    readonly recorder: Recorder,
  ) {
    this.decoder.onNoise = (text) => {
      const t = text.trim();
      if (t) session.log('N', t);
    };
  }

  private events(): TransportEvents {
    return {
      onBytes: (b) => this.onBytes(b),
      onClose: (reason) => this.onClose(reason),
    };
  }

  private setState(s: LinkState, error = '') {
    this.state = s;
    this.error = error;
    this.session.bump();
  }

  async connectSerial() {
    this.setState('connecting');
    try {
      const t = await WebSerialTransport.request(this.events());
      await this.attach(t);
    } catch (e) {
      this.setState('idle', String(e));
    }
  }

  async connectSim() {
    this.setState('connecting');
    await this.attach(new SimTransport(this.events()));
  }

  private async attach(t: Transport) {
    this.transport = t;
    this.wantReconnect = t.kind === 'serial';
    if (this.recorder.frames.length === 0) {
      this.session.reset();
      this.recorder.start(t.label);
    }
    this.setState('connected');
    await this.hello().catch(() => undefined);
    this.startKeepalive();
  }

  // The agent stops streaming when a write stalls (it assumes nobody is
  // reading) and resumes on the next command, so a short browser hiccup
  // costs at most one keepalive period.
  private startKeepalive() {
    this.stopKeepalive();
    this.keepalive = globalThis.setInterval(() => {
      if (this.transport && this.state === 'connected') this.command(C.PING, undefined, 2000).catch(() => undefined);
    }, 1000);
  }

  private stopKeepalive() {
    if (this.keepalive !== null) globalThis.clearInterval(this.keepalive);
    this.keepalive = null;
  }

  async disconnect() {
    this.wantReconnect = false;
    this.stopKeepalive();
    const t = this.transport;
    this.transport = null;
    await t?.close();
    this.failPending('disconnected');
    this.setState('idle');
  }

  private onBytes(b: Uint8Array) {
    const now = performance.now() - this.session.t0;
    for (const f of this.decoder.push(b)) {
      this.recorder.add(now, 'rx', f);
      this.handle(f, now);
    }
  }

  private handle(f: Frame, now: number) {
    if (f.type === T.ACK) {
      const a = jsonOf<any>(f.payload);
      const p = a && this.pending.get(a.seq);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(a.seq);
        p.resolve(a);
      }
    }
    this.session.apply(f, now);
  }

  private onClose(reason: string) {
    this.stopKeepalive();
    this.transport = null;
    this.failPending('link lost');
    this.session.log('N', `[otav] link lost (${reason})`);
    if (this.wantReconnect) {
      this.setState('reconnecting');
      this.reconnectLoop();
    } else {
      this.setState('idle', reason);
    }
  }

  // After an OTA the board reboots and the USB device re-enumerates. Keep
  // trying the already-granted port so the timeline continues across it.
  private async reconnectLoop() {
    for (let i = 0; i < 120 && this.wantReconnect && !this.transport; i++) {
      await sleep(500);
      try {
        const t = await WebSerialTransport.reopenKnown(this.events());
        if (t) {
          this.session.log('N', '[otav] reconnected');
          await this.attach(t);
          return;
        }
      } catch {
        /* not back yet */
      }
    }
    if (!this.transport) this.setState('idle', 'board did not come back');
  }

  private failPending(why: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
  }

  /** Sends a command and resolves with its ACK (rejects on NAK or timeout). */
  async command(type: number, payload?: Uint8Array, timeoutMs = 3000): Promise<any> {
    const t = this.transport;
    if (!t) throw new Error('not connected');
    let seq = this.seq++ & 0xffff;
    if (seq === 0) seq = this.seq++ & 0xffff;
    const frame = encodeFrame(type, seq, payload);
    const now = performance.now() - this.session.t0;
    this.recorder.add(now, 'tx', { type, seq, payload: payload ?? new Uint8Array() });
    const ack = new Promise<any>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (a) => (a.ok ? resolve(a) : reject(Object.assign(new Error(a.err ?? 'failed'), { ack: a }))),
        reject,
        timer,
      });
    });
    await t.write(frame);
    return ack;
  }

  hello() {
    return this.command(C.HELLO);
  }
  setRates(r: Record<string, number>) {
    return this.command(C.SET_RATES, jsonPayload(r));
  }
  watchRegs(add: { name: string; addr: number; group?: string }[], opts: { clear?: boolean; reset?: boolean } = {}) {
    return this.command(C.WATCH_REGS, jsonPayload({ ...opts, add }));
  }
  readMem(space: 0 | 1, addr: number, len: number) {
    return this.command(C.READ_MEM, readMemPayload(space, addr, len));
  }
  reboot() {
    return this.command(C.REBOOT);
  }
  appState(action: 'valid' | 'rollback') {
    return this.command(C.APP_STATE, jsonPayload({ action }));
  }

  /** Streams an app image over USB into the next OTA slot. */
  async flashOta(image: Uint8Array, reboot: boolean) {
    this.otaSend = { sent: 0, total: image.length, running: true };
    this.session.bump();
    try {
      if (image[0] !== 0xe9) throw new Error('not an ESP app image (first byte is not 0xE9)');
      await this.command(C.OTA_BEGIN, jsonPayload({ size: image.length }), 10000);
      for (let off = 0; off < image.length; off += OTA_CHUNK) {
        const chunk = image.subarray(off, Math.min(off + OTA_CHUNK, image.length));
        // The first write of each sector waits for its erase, hence the long timeout.
        await this.command(C.OTA_DATA, otaDataPayload(off, chunk), 10000);
        this.otaSend.sent = off + chunk.length;
        this.session.bump();
        if (!this.otaSend.running) throw new Error('cancelled');
      }
      await this.command(C.OTA_END, jsonPayload({ reboot }), 20000);
      this.otaSend.running = false;
    } catch (e) {
      this.otaSend.running = false;
      this.otaSend.error = String((e as Error).message ?? e);
      if (this.transport) await this.command(C.OTA_ABORT).catch(() => undefined);
      throw e;
    } finally {
      this.session.bump();
    }
  }

  cancelOta() {
    if (this.otaSend) this.otaSend.running = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
