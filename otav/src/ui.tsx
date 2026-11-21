// Small shared UI pieces: formatting, the session hook, sparklines, cards.

import { ComponentChildren } from 'preact';
import { useEffect, useReducer } from 'preact/hooks';
import { Session } from './session';

export const hex = (n: number | null | undefined, w = 8) =>
  n === null || n === undefined ? '—' : '0x' + (n >>> 0).toString(16).padStart(w, '0');

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(n % (1 << 20) ? 2 : 0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} KB`;
  return `${n} B`;
}

export const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Re-renders the caller at most once per animation frame when the session changes. */
export function useSession(s: Session) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let queued = false;
    return s.subscribe(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        force(0);
      });
    });
  }, [s]);
  return s;
}

export function Card(props: {
  title: string;
  sub?: ComponentChildren;
  actions?: ComponentChildren;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <section class={`card ${props.class ?? ''}`}>
      <header class="card-h">
        <h2>{props.title}</h2>
        {props.sub && <span class="card-sub">{props.sub}</span>}
        <span class="spacer" />
        {props.actions}
      </header>
      <div class="card-b">{props.children}</div>
    </section>
  );
}

export function Empty(props: { children: ComponentChildren }) {
  return <div class="empty">{props.children}</div>;
}

export function Sparkline(props: {
  t: number[];
  v: number[];
  width?: number;
  height?: number;
  windowMs?: number;
  now: number;
  min?: number;
  color?: string;
}) {
  const w = props.width ?? 240;
  const h = props.height ?? 44;
  const win = props.windowMs ?? 30000;
  const t0 = props.now - win;
  const pts: [number, number][] = [];
  for (let i = 0; i < props.t.length; i++) if (props.t[i] >= t0) pts.push([props.t[i], props.v[i]]);
  if (pts.length < 2) return <svg class="spark" width={w} height={h} />;
  const vs = pts.map((p) => p[1]);
  const lo = props.min ?? Math.min(...vs);
  const hi = Math.max(...vs, lo + 1e-9);
  const x = (t: number) => ((t - t0) / win) * (w - 2) + 1;
  const y = (v: number) => h - 2 - ((v - lo) / (hi - lo)) * (h - 6);
  const d = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  return (
    <svg class="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={props.color ?? 'var(--accent)'} stroke-width="1.5" />
    </svg>
  );
}

export function Badge(props: { tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted'; children: ComponentChildren; title?: string }) {
  return (
    <span class={`badge ${props.tone ?? 'muted'}`} title={props.title}>
      {props.children}
    </span>
  );
}

export function stateTone(state?: string | null): 'good' | 'warn' | 'bad' | 'info' | 'muted' {
  switch (state) {
    case 'valid':
      return 'good';
    case 'pending_verify':
    case 'new':
      return 'warn';
    case 'invalid':
    case 'aborted':
      return 'bad';
    default:
      return 'muted';
  }
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
