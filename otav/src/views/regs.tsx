// Peripheral registers (bit grid with change fade and decoded fields) and
// CPU state (per-core special registers, PC profile).

import { useState } from 'preact/hooks';
import { Device } from '../device';
import { REG_FIELDS, CPU_REG_NOTES, EXCCAUSE, fieldValue } from '../regdefs';
import { RegState, Session } from '../session';
import { Card, Empty, hex } from '../ui';

const FADE_MS = 1500;

export function Registers(props: { s: Session; dev: Device; live: boolean }) {
  const { s, dev, live } = props;
  const [open, setOpen] = useState<number | null>(null);
  const [addr, setAddr] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const regs = [...s.regs.values()];

  const add = async () => {
    setErr('');
    const a = Number(addr.trim());
    if (!Number.isFinite(a)) return setErr('address must be a number, e.g. 0x60008038');
    try {
      await dev.watchRegs([{ name: name || hex(a), addr: a >>> 0, group: 'user' }]);
      setAddr('');
      setName('');
    } catch (e) {
      setErr(`refused: ${(e as Error).message} (peripheral space 0x60000000–0x600D0FFC, 4-byte aligned, no FIFOs)`);
    }
  };

  return (
    <Card
      title="Peripheral registers"
      class="span2"
      sub={`${regs.length} watched · ${s.hello?.rates?.regs ?? '?'} Hz · read by the firmware, no halt`}
      actions={
        live && (
          <div class="row gap">
            <input class="mono w9" placeholder="0x6000…" value={addr} onInput={(e) => setAddr((e.target as HTMLInputElement).value)} />
            <input class="w9" placeholder="name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <button disabled={!addr || dev.state !== 'connected'} onClick={add}>
              Watch
            </button>
          </div>
        )
      }
    >
      {err && <div class="error">{err}</div>}
      {regs.length === 0 ? (
        <Empty>No registers yet.</Empty>
      ) : (
        <table class="regs">
          <thead>
            <tr>
              <th>group</th>
              <th>register</th>
              <th>address</th>
              <th>value</th>
              <th class="bits-h">
                <span>31</span>
                <span>0</span>
              </th>
              <th>changes</th>
            </tr>
          </thead>
          <tbody>
            {regs.map((r) => (
              <>
                <tr class="reg-row" onClick={() => setOpen(open === r.addr ? null : r.addr)}>
                  <td class="dim">{r.group}</td>
                  <td>{r.name}</td>
                  <td class="mono dim">{hex(r.addr)}</td>
                  <td class="mono">{hex(r.value)}</td>
                  <td>
                    <Bits r={r} now={s.now} />
                  </td>
                  <td class="mono dim">{r.changes}</td>
                </tr>
                {open === r.addr && (
                  <tr>
                    <td colSpan={6}>
                      <Fields r={r} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Bits(props: { r: RegState; now: number }) {
  const v = props.r.value ?? 0;
  const cells = [];
  for (let b = 31; b >= 0; b--) {
    const on = (v >>> b) & 1;
    const age = props.now - props.r.bitChangedAt[b];
    const hot = age < FADE_MS ? 1 - age / FADE_MS : 0;
    cells.push(
      <i
        class={`bit ${on ? 'on' : ''} ${b % 8 === 0 ? 'byte' : ''}`}
        style={hot ? { boxShadow: `0 0 0 2px rgba(255, 170, 40, ${hot.toFixed(2)})` } : undefined}
        title={`bit ${b}`}
      />,
    );
  }
  return <span class="bits">{cells}</span>;
}

function Fields(props: { r: RegState }) {
  const defs = REG_FIELDS[props.r.name];
  const v = props.r.value ?? 0;
  if (!defs) return <div class="dim fields">No field definitions for this register; bits only.</div>;
  return (
    <table class="fields">
      <tbody>
        {defs.map((f) => {
          const fv = fieldValue(v, f);
          return (
            <tr>
              <td class="mono dim">{f.hi === f.lo ? `[${f.lo}]` : `[${f.hi}:${f.lo}]`}</td>
              <td>{f.name}</td>
              <td class="mono">{f.hi === f.lo ? fv : `${fv} (${hex(fv, 0)})`}</td>
              <td class="dim">{f.enum?.[fv] ?? f.desc ?? ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- CPU -----------------------------------------------------------------

export function CpuPanel(props: { s: Session }) {
  const s = props.s;
  if (!s.cpu.length) return <Card title="CPU registers">{<Empty>Waiting…</Empty>}</Card>;
  const names = Object.keys(s.cpu[0]).filter((k) => k !== 'core');
  return (
    <Card title="CPU registers" sub="special registers per core, sampled live">
      <table class="cpu">
        <thead>
          <tr>
            <th>reg</th>
            {s.cpu.map((c) => (
              <th>core {c.core}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {names.map((n) => (
            <tr title={CPU_REG_NOTES[n]}>
              <td>{n}</td>
              {s.cpu.map((c, i) => {
                const changed = s.cpuPrev[i] && s.cpuPrev[i][n] !== c[n];
                return (
                  <td class={`mono ${changed ? 'chg' : ''}`}>
                    {n === 'EXCCAUSE' ? `${c[n]} ${EXCCAUSE[c[n]] ?? ''}` : n === 'PS' ? psText(c[n]) : hex(c[n])}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div class="dim note">
        Taken by a helper task on each core, so PC-like values describe that moment, not the app. The full register file
        (a0–a15, PC of every task) needs a JTAG halt, which is the planned deep mode.
      </div>
    </Card>
  );
}

function psText(ps: number) {
  return `${hex(ps)} lvl${ps & 0xf}${ps & 0x10 ? ' EXCM' : ''}${ps & 0x40000 ? ' WOE' : ''}`;
}

// --- PC profile ----------------------------------------------------------

export function PcProfile(props: { s: Session }) {
  const s = props.s;
  const elf = s.elf;
  const cores = s.pc.filter(Boolean);
  if (!cores.length) return <Card title="Where the CPUs are">{<Empty>Waiting for PC samples…</Empty>}</Card>;
  return (
    <Card
      title="Where the CPUs are"
      sub={`PC sampled every ${cores[0].periodUs} µs · last ${cores[0].pcs.length} samples${elf ? '' : ' · load the .elf for names'}`}
    >
      <div class="pc-cols">
        {cores.map((c) => {
          const counts = new Map<string, number>();
          for (const pc of c.pcs) {
            const sym = elf?.lookup(pc);
            const key = sym ? sym.name : `${hex(pc & ~0xff)}…`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
          const n = c.pcs.length || 1;
          return (
            <div>
              <h3>core {c.core}</h3>
              {top.map(([k, v]) => (
                <div class="bar-row" title={`${v} samples`}>
                  <div class="bar" style={{ width: `${(v / n) * 100}%` }} />
                  <span class="bar-l mono">{k}</span>
                  <span class="bar-v">{((v / n) * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
