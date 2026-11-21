import { useMemo, useState } from 'preact/hooks';
import { Device } from './device';
import { loadElf } from './elf';
import { Player, Recorder, parseRecording } from './recording';
import { Session } from './session';
import { webSerialSupported } from './transport';
import { Badge, bytes, download, secs, useSession } from './ui';
import { FlashMap } from './views/flash';
import { OtaPanel, OtadataPanel } from './views/ota';
import { CpuPanel, PcProfile, Registers } from './views/regs';
import { Crash, Health, Logs, Memory, Tasks } from './views/system';

export function App() {
  const session = useMemo(() => new Session(), []);
  const recorder = useMemo(() => new Recorder(), []);
  const dev = useMemo(() => new Device(session, recorder), [session, recorder]);
  const [player, setPlayer] = useState<Player | null>(null);
  const [elfErr, setElfErr] = useState('');
  useSession(session);

  const live = !player;
  const h = session.hello;
  const elfMatch = session.elf && h ? session.elf.sha256.startsWith(h.app.sha.slice(0, 16)) : null;

  const openRecording = async (f: File) => {
    await dev.disconnect();
    const { header, frames } = parseRecording(await f.text());
    setPlayer(new Player(session, header, frames));
  };

  const closeReplay = () => {
    player?.pause();
    setPlayer(null);
    session.reset();
  };

  const onElf = async (f: File) => {
    setElfErr('');
    try {
      session.setElf(await loadElf(f));
    } catch (e) {
      setElfErr(String((e as Error).message));
    }
  };

  const connected = dev.state === 'connected';

  return (
    <div class="app">
      <header class="top">
        <div class="brand">
          OTAV <span class="dim">over-the-air viewer</span>
        </div>
        {live ? (
          <div class="row gap">
            {dev.state === 'idle' ? (
              <>
                <button
                  class="primary"
                  disabled={!webSerialSupported()}
                  title={webSerialSupported() ? '' : 'WebSerial needs Chrome, Edge or Opera on desktop'}
                  onClick={() => {
                    recorder.clear();
                    dev.connectSerial();
                  }}
                >
                  Connect board
                </button>
                <button
                  onClick={() => {
                    recorder.clear();
                    dev.connectSim();
                  }}
                >
                  Simulator
                </button>
              </>
            ) : (
              <button onClick={() => dev.disconnect()}>Disconnect</button>
            )}
            <Badge tone={connected ? 'good' : dev.state === 'reconnecting' ? 'warn' : 'muted'}>
              {dev.state}
              {dev.transport ? ` · ${dev.transport.label}` : ''}
            </Badge>
            {recorder.frames.length > 0 && (
              <button
                title="Download everything received so far as an .otav.jsonl recording"
                onClick={() =>
                  download(recorder.toBlob(), `otav-${new Date().toISOString().replace(/[:.]/g, '-')}.otav.jsonl`)
                }
              >
                Save recording · {secs(recorder.durationMs)}
              </button>
            )}
          </div>
        ) : (
          <ReplayBar player={player!} onClose={closeReplay} />
        )}
        <span class="spacer" />
        <label class="file">
          <input type="file" accept=".jsonl,.otav,.ndjson" onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) openRecording(f).catch((err) => alert(String(err)));
          }} />
          Open recording
        </label>
        <label class="file" title="The app .elf (build/robot_face.elf) names sampled PCs and crash backtraces">
          <input type="file" accept=".elf" onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) onElf(f);
          }} />
          {session.elf ? session.elf.fileName : 'Load .elf'}
        </label>
        {elfMatch === false && <Badge tone="warn" title="SHA-256 of this ELF differs from the running app's">ELF ≠ running app</Badge>}
        {elfMatch === true && <Badge tone="good">ELF matches</Badge>}
      </header>
      {(dev.error || elfErr) && <div class="error banner">{dev.error || elfErr}</div>}

      {h && (
        <div class="ident">
          <span>
            <b>{h.app.proj}</b> {h.app.ver}
          </span>
          <span class="dim">IDF {h.app.idf}</span>
          <span class="dim">
            {h.chip} rev {h.rev} · {h.cores} cores · {h.cpu_mhz} MHz · flash {bytes(h.flash)} · PSRAM {bytes(h.psram)}
          </span>
          <span class="dim mono">{h.mac}</span>
          <Badge tone={h.reset === 'panic' || h.reset.includes('wdt') ? 'bad' : 'muted'}>reset: {h.reset}</Badge>
          <Badge tone={h.sec.flash_enc || h.sec.secure_boot ? 'warn' : 'muted'}>
            flash encryption {h.sec.flash_enc ? 'on' : 'off'} · secure boot {h.sec.secure_boot ? 'on' : 'off'}
          </Badge>
          <span class="dim">agent {h.agent}</span>
        </div>
      )}

      {!h && live && dev.state === 'idle' && <Welcome />}

      {(h || !live) && (
        <main class="grid">
          <Crash s={session} />
          <FlashMap s={session} />
          <OtaPanel s={session} dev={dev} live={live} />
          <OtadataPanel s={session} />
          <Registers s={session} dev={dev} live={live} />
          <CpuPanel s={session} />
          <PcProfile s={session} />
          <Tasks s={session} />
          <Health s={session} />
          <Logs s={session} />
          <Memory s={session} dev={dev} live={live} />
        </main>
      )}
    </div>
  );
}

function ReplayBar(props: { player: Player; onClose: () => void }) {
  const p = props.player;
  return (
    <div class="row gap replay">
      <Badge tone="info">replay · {p.header.source}</Badge>
      {p.playing ? <button onClick={() => p.pause()}>Pause</button> : <button class="primary" onClick={() => p.play()}>Play</button>}
      <input
        type="range"
        min={0}
        max={Math.round(p.duration)}
        value={Math.round(p.pos)}
        onInput={(e) => {
          p.pause();
          p.seek(Number((e.target as HTMLInputElement).value));
        }}
      />
      <span class="mono">
        {secs(p.pos)} / {secs(p.duration)}
      </span>
      <select
        value={p.speed}
        onChange={(e) => {
          p.speed = Number((e.target as HTMLSelectElement).value);
        }}
      >
        {[0.25, 0.5, 1, 2, 4, 8].map((x) => (
          <option value={x}>{x}×</option>
        ))}
      </select>
      <button onClick={props.onClose}>Close replay</button>
    </div>
  );
}

function Welcome() {
  return (
    <div class="welcome">
      <h1>Watch an OTA update from the inside</h1>
      <ol>
        <li>
          Flash the robot-face firmware with the OTAV agent once over USB: <code>idf.py -p PORT flash</code>.
        </li>
        <li>
          Click <b>Connect board</b> and pick the <code>USB JTAG/serial debug unit</code> port (Chrome or Edge).
        </li>
        <li>
          Build a new version, choose <code>build/robot_face.bin</code> in the OTA card and send it. Watch the sectors fill,
          otadata flip, the reboot, and the mark-valid.
        </li>
      </ol>
      <p class="dim">
        No board handy? <b>Simulator</b> runs a fake device that speaks the same protocol. Every session can be saved and
        replayed later with <b>Open recording</b>.
      </p>
    </div>
  );
}
