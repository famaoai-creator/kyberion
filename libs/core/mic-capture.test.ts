import { describe, expect, it } from 'vitest';
import { probeMicCapture, selectMacPhysicalAudioDevice, startMicCapture } from './mic-capture.js';

/** Emits `seconds` of synthetic PCM_S16LE audio on stdout via node -e. */
function fixtureCommand(bytes: number): string[] {
  return [
    process.execPath,
    '-e',
    `const b=Buffer.alloc(${bytes});for(let i=0;i<b.length;i+=2)b.writeInt16LE(((i%64)-32)*400,i);process.stdout.write(b);`,
  ];
}

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
