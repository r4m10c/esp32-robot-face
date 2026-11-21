// Flash map: the whole chip as partitions, plus a 4 KB sector grid of the
// slot an OTA is writing into.

import { useEffect, useRef } from 'preact/hooks';
import { Partition, Session } from '../session';
import { Badge, Card, Empty, bytes, hex, stateTone } from '../ui';

const TYPE_CLASS = (p: Partition) =>
  p.t === 0 ? 'seg-app' : p.st === 0 ? 'seg-otadata' : p.st === 3 ? 'seg-core' : 'seg-data';

interface Seg {
  label: string;
  o: number;
  s: number;
  cls: string;
  part?: Partition;
}

function segments(s: Session): Seg[] {
  const p = s.partitions!;
  const segs: Seg[] = [
    { label: 'bootloader', o: 0, s: 0x8000, cls: 'seg-boot' },
    { label: 'ptable', o: 0x8000, s: 0x1000, cls: 'seg-boot' },
  ];
  const parts = [...p.parts].sort((a, b) => a.o - b.o);
  let cursor = 0x9000;
  for (const part of parts) {
    if (part.o > cursor) segs.push({ label: 'free', o: cursor, s: part.o - cursor, cls: 'seg-free' });
    segs.push({ label: part.l, o: part.o, s: part.s, cls: TYPE_CLASS(part), part });
    cursor = part.o + part.s;
  }
  if (cursor < p.flash) segs.push({ label: 'free', o: cursor, s: p.flash - cursor, cls: 'seg-free' });
  return segs;
}

export function FlashMap(props: { s: Session }) {
  const s = props.s;
  const p = s.partitions;
  if (!p) return <Card title="Flash">{<Empty>Waiting for the partition table…</Empty>}</Card>;

  const segs = segments(s);
  // Square-root widths: 4 KB and 8 MB partitions both stay visible and labelled.
  const weights = segs.map((g) => Math.sqrt(g.s));
  const total = weights.reduce((a, b) => a + b, 0);
  const ota = s.ota;
  const odFlash = s.now - s.otadataChangedAt < 2500 && s.otadataChangedAt > 0;

  return (
    <Card
      title="Flash"
      sub={`${bytes(p.flash)} · widths are square-root scaled`}
      actions={
        <span class="legend">
          <i class="seg-app" /> app <i class="seg-otadata" /> otadata <i class="seg-data" /> data <i class="seg-core" /> coredump
        </span>
      }
    >
      <div class="flashbar">
        {segs.map((g, i) => {
          const part = g.part;
          const writing = !!(ota?.active && part && ota.part === part.l);
          const frac = writing ? Math.min(1, ota!.written / part!.s) : 0;
          return (
            <div
              class={`seg ${g.cls} ${g.label === 'otadata' && odFlash ? 'pulse' : ''} ${writing ? 'writing' : ''}`}
              style={{ flexGrow: weights[i] / total }}
              title={`${g.label}\n${hex(g.o, 6)} – ${hex(g.o + g.s, 6)}\n${bytes(g.s)}`}
            >
              {writing && <div class="seg-fill" style={{ width: `${frac * 100}%` }} />}
              <div class="seg-l">{g.label}</div>
              <div class="seg-m">{bytes(g.s)}</div>
              {part && (
                <div class="seg-badges">
                  {p.running === part.l && <Badge tone="info">running</Badge>}
                  {p.boot === part.l && p.boot !== p.running && <Badge tone="warn">boots next</Badge>}
                  {p.next === part.l && !writing && <Badge>next OTA</Badge>}
                  {writing && <Badge tone="warn">writing</Badge>}
                  {part.state && part.t === 0 && <Badge tone={stateTone(part.state)}>{part.state}</Badge>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div class="flash-detail">
        <SectorGrid s={s} />
        <AppSlots s={s} />
      </div>
    </Card>
  );
}

function AppSlots(props: { s: Session }) {
  const p = props.s.partitions!;
  const apps = p.parts.filter((x) => x.t === 0);
  return (
    <div class="slots">
      {apps.map((a) => (
        <div class={`slot ${p.running === a.l ? 'slot-run' : ''}`}>
          <div class="slot-h">
            <b>{a.l}</b> <span class="mono dim">{hex(a.o, 6)}</span>
            <span class="spacer" />
            {a.state && <Badge tone={stateTone(a.state)}>{a.state}</Badge>}
          </div>
          {a.app ? (
            <div class="slot-b">
              <div>
                {a.app.proj} <b>{a.app.ver}</b>
              </div>
              <div class="dim">
                IDF {a.app.idf} · {a.app.date} {a.app.time}
              </div>
              <div class="mono dim">elf {a.app.sha.slice(0, 16)}</div>
            </div>
          ) : (
            <div class="slot-b dim">empty or not a valid image</div>
          )}
        </div>
      ))}
    </div>
  );
}

const COLS = 128;

function SectorGrid(props: { s: Session }) {
  const s = props.s;
  const ref = useRef<HTMLCanvasElement>(null);
  const p = s.partitions!;
  const ota = s.ota;
  const target = ota ? p.parts.find((x) => x.l === ota.part) : p.parts.find((x) => x.l === p.next);

  useEffect(() => {
    const c = ref.current;
    if (!c || !target) return;
    const sectors = Math.ceil(target.s / 4096);
    const rows = Math.ceil(sectors / COLS);
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 600;
    const cell = Math.max(3, Math.floor(cssW / COLS));
    const cssH = rows * cell;
    c.width = COLS * cell * dpr;
    c.height = cssH * dpr;
    c.style.height = `${cssH}px`;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(c);
    const col = (n: string) => css.getPropertyValue(n).trim();
    const cBlank = col('--cell');
    const cErased = col('--cell-erased');
    const cWritten = col('--cell-written');
    const cHead = col('--cell-head');
    const cFail = col('--cell-fail');
    const written = ota && ota.part === target.l ? ota.written : 0;
    const erased = ota && ota.part === target.l ? ota.erased : 0;
    const failed = ota && ota.ok === false;
    const headSector = Math.floor(Math.max(0, written - 1) / 4096);
    for (let i = 0; i < sectors; i++) {
      const start = i * 4096;
      let fill = cBlank;
      if (start < written) fill = failed ? cFail : cWritten;
      else if (start < erased) fill = cErased;
      if (ota?.active && i === headSector && written > 0) fill = cHead;
      g.fillStyle = fill;
      g.fillRect((i % COLS) * cell, Math.floor(i / COLS) * cell, cell - 1, cell - 1);
    }
  });

  if (!target) return <Empty>No OTA slot found in the partition table.</Empty>;
  const sectors = Math.ceil(target.s / 4096);
  return (
    <div class="sectors">
      <div class="sectors-h">
        <b>{target.l}</b> sector map <span class="dim">· {sectors} × 4 KB</span>
        <span class="spacer" />
        <span class="legend">
          <i class="c-blank" /> untouched <i class="c-erased" /> erased <i class="c-written" /> written <i class="c-head" /> writing now
        </span>
      </div>
      <canvas ref={ref} class="sector-canvas" />
      {ota && ota.part === target.l && (
        <div class="sectors-f dim">
          image {bytes(ota.image)} · written {bytes(ota.written)} ({((ota.written / Math.max(1, ota.image)) * 100).toFixed(1)}%) ·
          erased to {hex(target.o + ota.erased, 6)}
        </div>
      )}
    </div>
  );
}
