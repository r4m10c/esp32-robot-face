import { describe, expect, it } from 'vitest';
import { Device } from './device';
import { Player, Recorder, parseRecording } from './recording';
import { Session } from './session';

// Drives a full USB OTA against the simulator through the real encoder,
// decoder, device controller and session, then replays the recording.
describe('simulated OTA', () => {
  it('writes an image, flips otadata, and replays identically', async () => {
    const session = new Session();
    const rec = new Recorder();
    const dev = new Device(session, rec);
    await dev.connectSim();
    expect(session.hello?.chip).toBe('esp32s3');
    expect(session.partitions?.running).toBe('ota_0');
    const before = session.otadata!;

    const image = new Uint8Array(64 * 1024).map((_, i) => (i * 13) & 0xff);
    image[0] = 0xe9;
    await dev.flashOta(image, false);

    const evs = session.otaEvents.map((e) => e.ev);
    expect(evs).toEqual(expect.arrayContaining(['begin', 'image_info', 'verify', 'end', 'set_boot']));
    expect(session.ota?.ok).toBe(true);
    expect(session.ota?.written).toBe(image.length);
    expect(session.partitions?.boot).toBe('ota_1');
    expect(session.otadata!.boot_slot).toBe(1);
    expect(session.otadata!.e.map((e) => e.raw)).not.toEqual(before.e.map((e) => e.raw));
    await dev.disconnect();

    // Replay the recording into a fresh session and compare the end state.
    const text = await rec.toBlob().text();
    const { header, frames } = parseRecording(text);
    const replayed = new Session();
    const player = new Player(replayed, header, frames);
    player.seek(player.duration);
    expect(replayed.otadata?.boot_slot).toBe(1);
    expect(replayed.ota?.written).toBe(image.length);
    expect(replayed.otaEvents.map((e) => e.ev)).toEqual(evs);
  }, 20000);

  it('rejects an image that does not start with 0xE9', async () => {
    const dev = new Device(new Session(), new Recorder());
    await dev.connectSim();
    await expect(dev.flashOta(new Uint8Array(100), false)).rejects.toThrow(/0xE9/);
    await dev.disconnect();
  });
});
