import { describe, expect, it } from 'vitest';
import {
  buildCaptureCommand,
  listMacAudioDevices,
  pcmRms,
  probeMicCapture,
  recommendCaptureSource,
  resolveCaptureDevices,
  resolveMacCaptureSource,
  selectMacPhysicalAudioDevice,
  selectMacSystemAudioDevice,
  startMicCapture,
} from './mic-capture.js';

/** A real macOS host's device list: loopback driver first, then built-in mic and conferencing virtual inputs. */
const P = '[AVFoundation indev @ 0x1]';
const HOST_LISTING = [
  '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
  '[AVFoundation indev @ 0x1] [0] BlackHole 2ch',
  '[AVFoundation indev @ 0x1] [1] MacBook Pro Microphone',
  '[AVFoundation indev @ 0x1] [2] Microsoft Teams Audio',
  '[AVFoundation indev @ 0x1] [3] ZoomAudioDevice',
].join('\n');

/** Emits `seconds` of synthetic PCM_S16LE audio on stdout via node -e. */
function fixtureCommand(bytes: number): string[] {
  return [
    process.execPath,
    '-e',
    `const b=Buffer.alloc(${bytes});for(let i=0;i<b.length;i+=2)b.writeInt16LE(((i%64)-32)*400,i);process.stdout.write(b);`,
  ];
}

describe('capture source selection', () => {
  it('lists devices and flags loopback drivers as virtual', () => {
    const devices = listMacAudioDevices(HOST_LISTING);
    expect(devices.map((d) => [d.device, d.virtual])).toEqual([
      [':0', true],
      [':1', false],
      [':2', false],
      [':3', false],
    ]);
  });

  it('maps room audio to the physical mic and remote audio to the loopback device', () => {
    expect(selectMacPhysicalAudioDevice(HOST_LISTING)).toBe(':1');
    expect(selectMacSystemAudioDevice(HOST_LISTING)).toBe(':0');
    expect(resolveMacCaptureSource(HOST_LISTING, 'mic')).toEqual([':1']);
    expect(resolveMacCaptureSource(HOST_LISTING, 'system')).toEqual([':0']);
    expect(resolveMacCaptureSource(HOST_LISTING, 'both')).toEqual([':1', ':0']);
  });

  it('prefers BlackHole over other virtual devices for system audio', () => {
    const listing = [
      `${P} AVFoundation audio devices:`,
      `${P} [0] Aggregate Device`,
      `${P} [1] BlackHole 16ch`,
      `${P} [2] Built-in Microphone`,
    ].join('\n');
    expect(selectMacSystemAudioDevice(listing)).toBe(':1');
  });

  it('fails loudly when the requested source does not exist', () => {
    const noLoopback = `${P} AVFoundation audio devices:\n${P} [0] Built-in Microphone`;
    expect(() => resolveMacCaptureSource(noLoopback, 'system')).toThrow(/loopback/);
    expect(() => resolveMacCaptureSource(noLoopback, 'both')).toThrow(/loopback/);
    expect(() =>
      resolveMacCaptureSource(`${P} AVFoundation audio devices:\n${P} [0] BlackHole 2ch`, 'mic')
    ).toThrow(/microphone/);
  });

  it('opens one input per device and mixes only when there are several', () => {
    const single = buildCaptureCommand([':1'], 16000, 'darwin');
    expect(single.filter((a) => a === '-i')).toHaveLength(1);
    expect(single).not.toContain('-filter_complex');

    const mixed = buildCaptureCommand([':1', ':0'], 16000, 'darwin');
    const inputs = mixed.flatMap((a, i) => (a === '-i' ? [mixed[i + 1]] : []));
    expect(inputs).toEqual([':1', ':0']);
    const graph = mixed[mixed.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:a]aresample=async=1[a0]');
    expect(graph).toContain('[1:a]aresample=async=1[a1]');
    expect(graph).toContain('amix=inputs=2:duration=longest,volume=2,alimiter=limit=0.95[mix]');
    expect(mixed[mixed.indexOf('-map') + 1]).toBe('[mix]');
    expect(mixed.slice(-7)).toEqual(['-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  });

  it('keeps an explicit device verbatim as a single input, even if its name contains "+"', () => {
    expect(resolveCaptureDevices('Jabra Speak+ 510')).toEqual(['Jabra Speak+ 510']);
    const argv = buildCaptureCommand(resolveCaptureDevices('Jabra Speak+ 510'), 16000, 'darwin');
    expect(argv.filter((a) => a === '-i')).toEqual(['-i']);
    expect(argv[argv.indexOf('-i') + 1]).toBe('Jabra Speak+ 510');
  });

  it('rejects an ambiguous device + source combination', () => {
    expect(() => resolveCaptureDevices(':1', 'mic')).toThrow(/either a device or a source/);
  });

  it('recommends a source per meeting shape', () => {
    expect(recommendCaptureSource('room')).toBe('mic');
    expect(recommendCaptureSource('remote')).toBe('system');
    expect(recommendCaptureSource('hybrid')).toBe('both');
  });

  it('measures PCM level so silence can be told from speech', () => {
    expect(pcmRms(new Uint8Array(3200))).toBe(0);
    const loud = Buffer.alloc(3200);
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(((i % 64) - 32) * 900, i);
    expect(pcmRms(loud)).toBeGreaterThan(0.01);
  });
});

describe('mic-capture', () => {
  it('skips virtual macOS inputs instead of assuming :0 is a physical microphone', () => {
    const listing = [
      '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
      '[AVFoundation indev @ 0x1] [0] BlackHole 2ch',
      '[AVFoundation indev @ 0x1] [1] Anker PowerConf C200',
      '[AVFoundation indev @ 0x1] [2] Fammy Microphone',
    ].join('\n');

    expect(selectMacPhysicalAudioDevice(listing)).toBe(':1');
    expect(selectMacPhysicalAudioDevice('[0] BlackHole 2ch')).toBeUndefined();
  });

  it('probes custom commands as available', () => {
    const probe = probeMicCapture({ command: ['echo'] });
    expect(probe.available).toBe(true);
    expect(probe.backend).toBe('custom');
  });

  it('chunks a PCM stream into AudioChunk frames', async () => {
    // 16kHz * 2 bytes * 0.5s = 16000 bytes → 5 chunks at 100ms (3200 bytes).
    const session = await startMicCapture({
      command: fixtureCommand(16_000),
      sampleRateHz: 16000,
      chunkMs: 100,
    });

    const chunks = [];
    for await (const chunk of session.chunks()) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(5);
    expect(chunks[0]?.payload.byteLength).toBe(3200);
    expect(chunks[0]?.format).toEqual({
      encoding: 'pcm_s16le',
      sample_rate_hz: 16000,
      channels: 1,
    });
    await session.stop();
  });

  it('stop() terminates a long-running capture', async () => {
    const session = await startMicCapture({
      command: [
        process.execPath,
        '-e',
        'setInterval(()=>process.stdout.write(Buffer.alloc(3200)),50);',
      ],
      sampleRateHz: 16000,
      chunkMs: 100,
    });

    const received: number[] = [];
    const reader = (async () => {
      for await (const chunk of session.chunks()) {
        received.push(chunk.payload.byteLength);
        if (received.length >= 2) break;
      }
    })();
    await reader;
    await session.stop();
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces spawn failures as errors', async () => {
    const session = await startMicCapture({
      command: ['/nonexistent-binary-for-test'],
      sampleRateHz: 16000,
    });
    await expect(async () => {
      for await (const chunk of session.chunks()) {
        void chunk;
      }
    }).rejects.toThrow(/mic-capture/);
  });
});
