import { assertPerceptionOutput } from './lib/perception.js';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver, safeMkdir, safeWriteFile, safeRmSync } from '@agent/core';
import { runSeeCommand } from './cli-see.js';
import { runListenCommand } from './cli-listen.js';
import { runWatchCommand } from './cli-watch.js';
import { createFakeDeps, fakeBridge } from './lib/perception.test-support.js';
import { compareFingerprints } from '@agent/core/perception/visual-change';
let dir: string, image: string, audio: string, video: string;
beforeAll(() => {
  dir = pathResolver.sharedTmp('perception-feature-' + randomUUID());
  safeMkdir(dir, { recursive: true });
  image = path.join(dir, 'card.png');
  audio = path.join(dir, 'audio.wav');
  video = path.join(dir, 'video.mp4');
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47);
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(100, 20);
  safeWriteFile(image, png);
  safeWriteFile(audio, 'RIFF');
  safeWriteFile(video, 'video');
});
afterAll(() => safeRmSync(dir, { recursive: true, force: true }));
describe('perception feature CLI integration', () => {
  it('refuses output to another public tenant partition', () => {
    expect(() =>
      assertPerceptionOutput(
        image,
        pathResolver.rootResolve('active/shared/tmp/public/foreign-tenant/out.json')
      )
    ).toThrow('tenant');
  });
  it('exposes OCR regions and source digest through canonical see handler', async () => {
    const deps = createFakeDeps();
    deps.ocr = async () => ({
      status: 'succeeded',
      provider: 'test-local',
      text: 'OK',
      confidence: 90,
      elapsedMs: 1,
      lines: [{ text: 'OK', confidence: 90, boundingBox: { x: 10, y: 20, width: 30, height: 40 } }],
    });
    const r = await runSeeCommand([image, '--grounded', '--json'], () => {}, deps);
    expect(r?.observations?.[0]).toMatchObject({
      source: { path: path.relative(pathResolver.rootDir(), image) },
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      provider: 'test-local',
    });
    expect(r!.observations![0]!.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('refuses source modification before grounded output is published', async () => {
    const changing = path.join(dir, 'changing.png');
    safeWriteFile(changing, Buffer.from('initial'));
    const deps = createFakeDeps();
    deps.ocr = async () => {
      safeWriteFile(changing, 'modified');
      return { status: 'succeeded', provider: 'test', text: 'x', confidence: 1, elapsedMs: 1 };
    };
    const output = vi.fn();
    await expect(runSeeCommand([changing, '--grounded'], output, deps)).rejects.toThrow(
      'source changed'
    );
    expect(output).not.toHaveBeenCalled();
  });
  it.each(['601', 'NaN', undefined])(
    'rejects analysis duration %s before STT or normalization',
    async (duration) => {
      const deps = createFakeDeps({ ffprobe: JSON.stringify({ format: { duration } }) });
      await expect(
        runListenCommand([audio, '--events', '--audio-model', 'model.tflite'], () => {}, deps)
      ).rejects.toThrow('duration');
      expect(deps.calls.filter((c) => c.tool === 'ffmpeg')).toHaveLength(0);
    }
  );
  it('analyzes non-speech audio without an installed STT backend', async () => {
    const deps = createFakeDeps({ ffprobe: JSON.stringify({ format: { duration: '4' } }) });
    const analyzeAudio = vi.fn(async () => ({
      provider: 'test-events',
      speakers: [],
      events: [{ start_sec: 0, end_sec: 1, label: 'Applause', confidence: 0.9 }],
      warnings: [],
    }));
    deps.enhancements = { analyzeAudio };
    const r = await runListenCommand(
      [audio, '--events', '--audio-model', 'yamnet.tflite', '--no-transcript', '--json'],
      () => {},
      deps
    );
    expect(r?.backend).toBe('analysis-only');
    expect(r?.observations?.[0]).toMatchObject({
      kind: 'sound_event',
      text: 'Applause',
      source: { path: path.relative(pathResolver.rootDir(), audio) },
    });
    expect(analyzeAudio).toHaveBeenCalledOnce();
  });
  it('preserves all overlapping speaker labels and tentative attribution', async () => {
    const deps = createFakeDeps({
      ffprobe: JSON.stringify({ format: { duration: '4' } }),
      bridges: [
        fakeBridge('local', { text: 'hi', segments: [{ start_sec: 0, end_sec: 2, text: 'hi' }] }),
      ],
    });
    deps.enhancements = {
      analyzeAudio: async () => ({
        provider: 'test-diarization',
        speakers: [
          { start_sec: 0, end_sec: 2, speaker_id: 'A' },
          { start_sec: 1, end_sec: 2, speaker_id: 'B' },
        ],
        events: [],
        warnings: [],
      }),
    };
    const r = await runListenCommand(
      [audio, '--diarize', '--diarization-model', 'bundle'],
      () => {},
      deps
    );
    expect(r?.segments?.[0]).toMatchObject({
      speaker_ids: ['A', 'B'],
      speaker_status: 'tentative',
    });
    expect(r?.observations?.find((o) => o.kind === 'speech')?.attributes).toMatchObject({
      speaker_ids: ['A', 'B'],
      speaker_status: 'tentative',
    });
  });
  it('keeps gradual cumulative visual changes and actual OCR provenance', async () => {
    const deps = createFakeDeps({
      frameCount: 4,
      ffprobe: JSON.stringify({
        format: { duration: '4' },
        streams: [{ codec_type: 'video', width: 100, height: 100 }],
      }),
    });
    let index = 0;
    deps.enhancements = {
      fingerprint: async () => ({ hash: '0'.repeat(16), pixels: Array(4096).fill(index++ * 4) }),
      compare: compareFingerprints,
    };
    const r = await runWatchCommand(
      [video, '--changes', '--every', '1', '--max-frames', '4'],
      () => {},
      deps
    );
    expect(r?.frames.map((f) => f.time_sec)).toEqual([0, 2]);
    expect(r?.observations?.find((o) => o.kind === 'text')?.provider).toBe('fake_ocr');
  });
  it('connects tracking and semantic indexing/query, preserving source paths', async () => {
    const deps = createFakeDeps();
    const index = vi.fn(async (_options: unknown) => ({
      index_id: 'demo',
      entries: 1,
      provider: 'test-semantic',
      expires_at: 'x',
      index_path: 'x',
    }));
    deps.enhancements = {
      track: async () => ({
        provider: 'mediapipe-local',
        frames: [{ time_sec: 0, faces: [], poses: [], gestures: [] }],
        warnings: [],
      }),
      index,
      search: async () => [{ id: 'image', path: image, score: 0.8 }],
    };
    const r = await runSeeCommand(
      [
        image,
        '--track',
        '--face-model',
        'face.task',
        '--index',
        'demo',
        '--embedding-model',
        'model',
      ],
      () => {},
      deps
    );
    expect(r?.tracking?.frames).toHaveLength(1);
    expect(index.mock.calls[0]?.[0]).toMatchObject({
      entries: [{ path: image, image_path: image }],
    });
    const query = await runSeeCommand(
      ['--search', 'portrait', '--index', 'demo', '--embedding-model', 'model'],
      () => {},
      deps
    );
    expect(query?.search).toHaveLength(1);
  });
  it('rejects missing assets and contradictory switches before inference', async () => {
    for (const args of [
      [image, '--track'],
      [image, '--diarize'],
      [image, '--index', 'demo'],
    ])
      await expect(runSeeCommand(args, () => {}, createFakeDeps())).rejects.toThrow();
    await expect(
      runListenCommand([audio, '--no-transcript'], () => {}, createFakeDeps())
    ).rejects.toThrow('requires');
  });
});
