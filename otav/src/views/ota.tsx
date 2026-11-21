// OTA control and timeline, and the otadata panel.

import { useState } from 'preact/hooks';
import { Device } from '../device';
import { OtadataEntry, Session } from '../session';
import { Badge, Card, Empty, Sparkline, bytes, hex, secs, stateTone } from '../ui';

const STAGES = ['begin', 'image_info', 'end', 'set_boot', 'reboot', 'boot', 'marked_valid'] as const;
const STAGE_LABEL: Record<string, string> = {
  begin: 'Begin',
  image_info: 'Header parsed',
  end: 'Verified',
  set_boot: 'Boot set',
  reboot: 'Reboot',
  boot: 'First boot',
  marked_valid: 'Marked valid',
};

export function OtaPanel(props: { s: Session; dev: Device; live: boolean }) {
  const { s, dev, live } = props;
  const [file, setFile] = useState<File | null>(null);
  const [reboot, setReboot] = useState(true);
  const [err, setErr] = useState('');
  const ota = s.ota;
  const send = dev.otaSend;
  const connected = live && dev.state === 'connected';

  const start = async () => {
    if (!file) return;
    setErr('');
    try {
      await dev.flashOta(new Uint8Array(await file.arrayBuffer()), reboot);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  // Which lifecycle stages have happened since the last "begin".
  const lastBegin = s.otaEvents.map((e) => e.ev).lastIndexOf('begin');
  const since = lastBegin >= 0 ? s.otaEvents.slice(lastBegin) : [];
  const seen = new Set(since.map((e) => e.ev));
  const failed = since.find((e) => e.ev === 'error' || e.ev === 'abort' || (e.ev === 'end' && !e.d.ok));

  const elapsed = ota ? (ota.endHostT ?? s.now) - ota.startHostT : 0;
  const avg = ota && elapsed > 0 ? (ota.written / elapsed) * 1000 : 0;
  const eta = ota?.active && avg > 0 ? ((ota.image - ota.written) / avg) * 1000 : 0;
  const bps = s.series['ota_bps'];

  return (
    <Card
      title="OTA"
      class="span2"
      sub={ota ? `${ota.part} · ${bytes(ota.image)}` : 'idle'}
      actions={
        live && (
          <div class="row gap">
            <label class="file">
              <input
                type="file"
                accept=".bin"
                onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
              />
              {file ? file.name : 'Choose app .bin'}
            </label>
            <label class="check">
              <input type="checkbox" checked={reboot} onChange={(e) => setReboot((e.target as HTMLInputElement).checked)} />
              reboot after
            </label>
            {send?.running ? (
              <button onClick={() => dev.cancelOta()}>Cancel</button>
            ) : (
              <button class="primary" disabled={!connected || !file} onClick={start}>
                Send OTA over USB
              </button>
            )}
          </div>
        )
      }
    >
      <div class="stages">
        {STAGES.map((st) => (
          <div class={`stage ${seen.has(st) ? 'done' : ''} ${failed && !seen.has(st) ? 'skipped' : ''}`}>
            <span class="dot" />
            {STAGE_LABEL[st]}
          </div>
        ))}
        {failed && (
          <div class="stage fail">
            <span class="dot" />
            {failed.ev === 'end' ? 'Validation failed' : failed.ev}
          </div>
        )}
      </div>

      {ota ? (
        <div class="ota-body">
          <div class="progress">
            <div class="progress-bar" style={{ width: `${(ota.written / Math.max(1, ota.image)) * 100}%` }} />
          </div>
          <div class="kv-row">
            <div>
              <span class="k">written</span> {bytes(ota.written)} / {bytes(ota.image)}
            </div>
            <div>
              <span class="k">avg</span> {bytes(Math.round(avg))}/s
            </div>
            <div>
              <span class="k">{ota.active ? 'eta' : 'took'}</span> {ota.active ? secs(eta) : secs(elapsed)}
            </div>
            <div>
              <span class="k">target</span> {ota.part} @ {hex(ota.addr, 6)}
            </div>
            {ota.ok !== null && <Badge tone={ota.ok ? 'good' : 'bad'}>{ota.ok ? 'image valid' : 'failed'}</Badge>}
          </div>
          {bps && (
            <div class="row gap">
              <span class="k">throughput</span>
              <Sparkline t={bps.t} v={bps.v} now={s.now} windowMs={Math.max(10000, elapsed + 2000)} width={360} min={0} />
            </div>
          )}
          {ota.info && (
            <div class="image-info">
              <span class="k">incoming image</span> {ota.info.proj} <b>{ota.info.ver}</b> · IDF {ota.info.idf} · {ota.info.date}{' '}
              {ota.info.time} · {ota.info.segments} segments · entry {hex(ota.info.entry)} ·{' '}
              <span class="mono">elf {ota.info.sha}</span>
              {ota.info.chip_id !== 9 && <Badge tone="bad">chip id {ota.info.chip_id} is not ESP32-S3</Badge>}
            </div>
          )}
        </div>
      ) : (
        <Empty>
          No update yet. Build the firmware with <code>idf.py build</code>, then send <code>build/robot_face.bin</code> here.
        </Empty>
      )}
      {(err || send?.error) && <div class="error">{err || send?.error}</div>}

      <BootState s={s} dev={dev} live={connected} />

      <div class="timeline">
        {s.otaEvents.slice(-14).map((e) => (
          <div class="tl-row">
            <span class="mono dim">{(e.hostT / 1000).toFixed(2)}s</span>
            <span class={`tl-ev ev-${e.ev}`}>{e.ev}</span>
            <span class="dim tl-d">{eventDetail(e.d)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function eventDetail(d: any): string {
  const skip = new Set(['t', 'ev']);
  return Object.entries(d)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${typeof v === 'number' && v > 0xffff ? hex(v) : v}`)
    .join('  ');
}

function BootState(props: { s: Session; dev: Device; live: boolean }) {
  const b = props.s.boot;
  if (!b) return null;
  const pending = b.state === 'pending_verify';
  const age = props.s.now - ([...props.s.otaEvents].reverse().find((e) => e.ev === 'boot')?.hostT ?? props.s.now);
  const remain = pending && b.valid_in_ms ? Math.max(0, b.valid_in_ms - age) : 0;
  return (
    <div class={`boot ${pending ? 'boot-pending' : ''}`}>
      <span>
        Running <b>{b.part}</b> <Badge tone={stateTone(b.state)}>{b.state}</Badge>
      </span>
      {pending && (
        <span class="dim">
          {b.auto_valid_ms ? `auto mark-valid in ${secs(remain)}` : 'waiting for a manual decision'} · a reset now rolls back
        </span>
      )}
      <span class="spacer" />
      {props.live && pending && (
        <>
          <button onClick={() => props.dev.appState('valid')}>Mark valid</button>
          <button class="danger" onClick={() => props.dev.appState('rollback')}>
            Roll back
          </button>
        </>
      )}
      {props.live && <button onClick={() => props.dev.reboot()}>Reboot</button>}
    </div>
  );
}

// --- otadata -------------------------------------------------------------

export function OtadataPanel(props: { s: Session }) {
  const od = props.s.otadata;
  if (!od) return <Card title="otadata">{<Empty>Waiting…</Empty>}</Card>;
  const prev = props.s.otadataPrev;
  const recent = props.s.now - props.s.otadataChangedAt < 4000 && props.s.otadataChangedAt > 0;
  return (
    <Card title="otadata" sub={`${hex(od.addr, 5)} · 2 × 4 KB sectors`}>
      <div class="od">
        {od.e.map((e, i) => (
          <OdEntry e={e} i={i} active={od.active === i} changed={recent && prev?.e[i]?.raw !== e.raw} />
        ))}
      </div>
      <div class="od-f">
        {od.boot_slot !== null ? (
          <>
            Bootloader picks entry <b>{od.active}</b> (highest valid seq) → slot{' '}
            <b>
              ota_{od.boot_slot} = (seq − 1) mod {od.slots}
            </b>
          </>
        ) : (
          <>No valid entry: the bootloader falls back to factory or ota_0.</>
        )}
      </div>
    </Card>
  );
}

function OdEntry(props: { e: OtadataEntry; i: number; active: boolean; changed: boolean }) {
  const e = props.e;
  const blank = e.seq === 0xffffffff;
  return (
    <div class={`od-e ${props.active ? 'od-active' : ''} ${props.changed ? 'flash-change' : ''}`}>
      <div class="od-h">
        <b>entry {props.i}</b> <span class="dim mono">sector {props.i}</span>
        <span class="spacer" />
        {props.active && <Badge tone="info">active</Badge>}
      </div>
      {blank ? (
        <div class="dim">erased (all 0xFF)</div>
      ) : (
        <div class="kv">
          <span class="k">ota_seq</span>
          <span class="mono">{e.seq}</span>
          <span class="k">ota_state</span>
          <span>
            <Badge tone={stateTone(e.stn)}>{e.stn}</Badge>
          </span>
          <span class="k">crc</span>
          <span class="mono">
            {hex(e.crc)} {e.crc_ok ? <Badge tone="good">ok</Badge> : <Badge tone="bad">bad</Badge>}
          </span>
        </div>
      )}
      <div class="mono raw" title="esp_ota_select_entry_t: ota_seq | seq_label[20] | ota_state | crc">
        {e.raw.match(/.{1,8}/g)?.join(' ')}
      </div>
    </div>
  );
}
