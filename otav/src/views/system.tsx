// Tasks, health metrics, logs, memory viewer and crash report.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Device } from '../device';
import { EXCCAUSE } from '../regdefs';
import { Session } from '../session';
import { Badge, Card, Empty, Sparkline, bytes, hex } from '../ui';

const TASK_STATE = ['running', 'ready', 'blocked', 'suspended', 'deleted'];

export function Tasks(props: { s: Session }) {
  const t = props.s.tasks;
  return (
    <Card title="Tasks" sub={`${t.length} tasks · CPU % of one core`}>
      {t.length === 0 ? (
        <Empty>Waiting…</Empty>
      ) : (
        <table class="tasks">
          <thead>
            <tr>
              <th>task</th>
              <th>state</th>
              <th>prio</th>
              <th>core</th>
              <th>stack free</th>
              <th>cpu</th>
            </tr>
          </thead>
          <tbody>
            {t.map((r) => (
              <tr>
                <td>{r.n}</td>
                <td class="dim">{TASK_STATE[r.s] ?? r.s}</td>
                <td class="mono">{r.p}</td>
                <td class="mono">{r.c < 0 ? 'any' : r.c}</td>
                <td class={`mono ${r.hw < 512 ? 'warn-t' : ''}`}>{bytes(r.hw)}</td>
                <td class="cpu-cell">
                  <div class="mini-bar" style={{ width: `${Math.min(100, r.cpu ?? 0)}%` }} />
                  <span class="mono">{r.cpu === null ? '—' : `${r.cpu.toFixed(1)}%`}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function Health(props: { s: Session }) {
  const s = props.s;
  const tm = s.telemetry;
  if (!tm) return <Card title="Health">{<Empty>Waiting…</Empty>}</Card>;
  const metrics = Object.keys(tm.m ?? {});
  const row = (label: string, key: string, value: string, min?: number) => {
    const ser = s.series[key];
    return (
      <div class="health-row">
        <div>
          <div class="k">{label}</div>
          <div class="hv">{value}</div>
        </div>
        {ser && <Sparkline t={ser.t} v={ser.v} now={s.now} width={180} height={36} min={min} />}
      </div>
    );
  };
  return (
    <Card title="Health" sub="last 30 s">
      {row('internal heap free', 'heap', `${bytes(tm.heap)} (min ${bytes(tm.heap_min)})`)}
      {row('PSRAM free', 'psram', `${bytes(tm.psram)} of ${bytes(tm.psram_tot)}`)}
      {metrics.map((m) => row(m, `m.${m}`, (tm.m[m] as number).toFixed(m === 'fps' ? 1 : 0), 0))}
      <div class="dim note">
        largest free block {bytes(tm.heap_big)} · frames dropped by the agent {tm.drops}
      </div>
    </Card>
  );
}

export function Logs(props: { s: Session }) {
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const lines = props.s.logs.filter((l) => !filter || l.text.toLowerCase().includes(filter.toLowerCase())).slice(-400);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  return (
    <Card
      title="Logs"
      class="span2"
      sub={`${props.s.logs.length} lines`}
      actions={
        <div class="row gap">
          <input placeholder="filter" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          <label class="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} />
            follow
          </label>
        </div>
      }
    >
      <div class="logs mono" ref={ref}>
        {lines.map((l) => (
          <div class={`log log-${l.level}`}>
            <span class="dim">{(l.hostT / 1000).toFixed(2).padStart(8)}</span> {l.text}
          </div>
        ))}
      </div>
    </Card>
  );
}

const PRESETS = [
  { label: 'otadata entry 0', space: 0 as const, addr: 0xf000, len: 64 },
  { label: 'otadata entry 1', space: 0 as const, addr: 0x10000, len: 64 },
  { label: 'ota_0 header', space: 0 as const, addr: 0x30000, len: 288 },
  { label: 'ota_1 header', space: 0 as const, addr: 0x430000, len: 288 },
  { label: 'partition table', space: 0 as const, addr: 0x8000, len: 256 },
];

export function Memory(props: { s: Session; dev: Device; live: boolean }) {
  const { s, dev, live } = props;
  const [space, setSpace] = useState<0 | 1>(0);
  const [addr, setAddr] = useState('0xf000');
  const [len, setLen] = useState('64');
  const [err, setErr] = useState('');
  const read = async (sp = space, a = Number(addr), n = Number(len)) => {
    setErr('');
    try {
      await dev.readMem(sp, a >>> 0, Math.min(2048, n));
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };
  const m = s.mem;
  return (
    <Card title="Memory" sub="flash or RAM, read by the firmware">
      {live && (
        <>
          <div class="row gap wrap">
            <select value={space} onChange={(e) => setSpace(Number((e.target as HTMLSelectElement).value) as 0 | 1)}>
              <option value={0}>flash</option>
              <option value={1}>RAM</option>
            </select>
            <input class="mono w9" value={addr} onInput={(e) => setAddr((e.target as HTMLInputElement).value)} />
            <input class="mono w5" value={len} onInput={(e) => setLen((e.target as HTMLInputElement).value)} />
            <button disabled={dev.state !== 'connected'} onClick={() => read()}>
              Read
            </button>
          </div>
          <div class="row gap wrap presets">
            {PRESETS.map((p) => (
              <button
                class="link"
                disabled={dev.state !== 'connected'}
                onClick={() => {
                  setSpace(p.space);
                  setAddr(hex(p.addr, 0));
                  setLen(String(p.len));
                  read(p.space, p.addr, p.len);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
      {err && <div class="error">{err}</div>}
      {m ? <HexDump base={m.addr} data={m.data} /> : <Empty>Nothing read yet.</Empty>}
    </Card>
  );
}

function HexDump(props: { base: number; data: Uint8Array }) {
  const rows = [];
  for (let o = 0; o < props.data.length; o += 16) {
    const slice = [...props.data.subarray(o, o + 16)];
    rows.push(
      <div>
        <span class="dim">{hex(props.base + o)}</span>{' '}
        {slice.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}{' '}
        <span class="dim">{slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}</span>
      </div>,
    );
  }
  return <div class="hexdump mono">{rows}</div>;
}

export function Crash(props: { s: Session }) {
  const c = props.s.crash;
  if (!c) return null;
  const elf = props.s.elf;
  const name = (pc: number) => elf?.lookup(pc)?.name ?? '';
  return (
    <Card title="Last crash" class="span3 crash" sub="core dump from the previous run">
      <div class="kv-row">
        <Badge tone="bad">{EXCCAUSE[c.cause] ?? `cause ${c.cause}`}</Badge>
        <span>
          task <b>{c.task}</b>
        </span>
        <span class="mono">
          PC {hex(c.pc)} {name(c.pc)}
        </span>
        <span class="mono">EXCVADDR {hex(c.vaddr)}</span>
      </div>
      {c.reason && <div class="mono">{c.reason}</div>}
      <div class="row gap wrap">
        <div>
          <h3>backtrace{c.bt_corrupt ? ' (corrupt)' : ''}</h3>
          {c.bt.map((pc: number) => (
            <div class="mono">
              {hex(pc)} <span class="dim">{name(pc)}</span>
            </div>
          ))}
        </div>
        <div>
          <h3>a0–a15</h3>
          <div class="areg mono">
            {c.a.map((v: number, i: number) => (
              <div>
                <span class="dim">a{i}</span> {hex(v)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
