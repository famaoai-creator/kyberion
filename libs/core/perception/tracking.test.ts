import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from '../secure-io.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  openTrackingSession,
  trackingObservations,
  parseTrackingResult,
  trackFrameStream,
  trackMedia,
  trackingFrameToAnimationCues,
  type TrackingFrame,
  type TrackingResult,
} from './tracking.js';

const frame = (time_sec = 0): TrackingFrame => ({
  time_sec,
  faces: [
    {
      landmarks: [{ x: 0.2, y: 0.3, z: -0.1 }],
      blendshapes: { jawOpen: 0.7, eyeBlinkLeft: 0.2, _neutral: 0.1 },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
  poses: [],
  gestures: [],
});
const result = (...frames: TrackingFrame[]): TrackingResult => ({
  provider: 'mediapipe-local',
  frames,
  warnings: [],
});

describe('local MediaPipe tracking contract', () => {
  it('preserves normalized geometry, blendshapes and decoded timestamps', () => {
    expect(parseTrackingResult(result(frame(0), frame(0.2)))).toEqual(result(frame(0), frame(0.2)));
  });
  it('rejects duplicate/reversed times and unbounded output', () => {
    expect(() => parseTrackingResult(result(frame(1), frame(1)))).toThrow(/increasing/);
    expect(() => parseTrackingResult(result(frame(2), frame(1)))).toThrow(/increasing/);
    expect(() => parseTrackingResult(result(frame(0), frame(1)), 1)).toThrow(/bounded/);
    expect(() => parseTrackingResult(result(frame(0)), 301)).toThrow(/maxFrames/);
  });
  it('rejects malformed geometry, scores, transforms, provider and warnings', () => {
    for (const invalid of [NaN, Infinity, -Infinity, '0.2']) {
      const f = frame();
      f.faces[0]!.landmarks[0]!.x = invalid as number;
      expect(() => parseTrackingResult(result(f))).toThrow(/finite/);
    }
    const badScore = frame();
    badScore.faces[0]!.blendshapes.jawOpen = 1.1;
    expect(() => parseTrackingResult(result(badScore))).toThrow(/finite/);
    const badMatrix = frame();
    badMatrix.faces[0]!.transform = [1];
    expect(() => parseTrackingResult(result(badMatrix))).toThrow(/4x4/);
    expect(() => parseTrackingResult({ ...result(), provider: 'cloud' })).toThrow(/provider/);
    expect(() => parseTrackingResult({ ...result(), warnings: ['a'.repeat(1025)] })).toThrow(
      /warning/
    );
    const unsafe = frame();
    unsafe.faces[0]!.blendshapes = JSON.parse('{"__proto__":0.5}');
    expect(() => parseTrackingResult(result(unsafe))).toThrow(/blendshape name/);
  });
  it('grounds face, pose and gesture facts on the original source digest/scope', () => {
    const source = {
      path: 'video.mp4',
      sha256: 'a'.repeat(64),
      scope: { tier: 'public' as const },
    };
    const f = frame(0.4);
    f.poses = [{ landmarks: [{ x: 0.2, y: 0.3, z: 0, visibility: 0.9 }] }];
    f.gestures = [{ label: 'Open_Palm', confidence: 0.9, landmarks: [] }];
    const facts = trackingObservations(source, result(f));
    expect(facts.map((fact) => fact.kind)).toEqual(['face', 'pose', 'gesture']);
    expect(
      facts.every(
        (fact) =>
          fact.source === source && fact.time?.start_sec === 0.4 && fact.time?.basis === 'decoded'
      )
    ).toBe(true);
    expect(facts[2]).toMatchObject({ modality: 'video', text: 'Open_Palm', confidence: 0.9 });
  });
  it('maps only the selected first face to an avatar without person identity', () => {
    const f = frame(1.2);
    f.gestures = [{ label: 'Open_Palm', confidence: 0.9, handedness: 'Right', landmarks: [] }];
    const cues = trackingFrameToAnimationCues(f, 'avatar-demo');
    expect(cues).toEqual([
      expect.objectContaining({
        at_ms: 1200,
        kind: 'blendshape',
        source: 'provider',
        payload: { jawOpen: 0.7, eyeBlinkLeft: 0.2, _neutral: 0.1 },
      }),
      expect.objectContaining({
        at_ms: 1200,
        kind: 'gesture',
        confidence: 0.9,
        payload: { label: 'Open_Palm', handedness: 'Right' },
      }),
    ]);
    expect(cues.every((cue) => cue.target_avatar_id === 'avatar-demo')).toBe(true);
    expect(() => trackingFrameToAnimationCues(f, '')).toThrow(/targetAvatarId/);
  });
});

describe('tracking process boundary', () => {
  let dir: string;
  beforeEach(() => {
    dir = pathResolver.rootResolve('active/shared/tmp/public/shared/tracking-test-' + randomUUID());
    safeMkdir(dir, { recursive: true });
    safeWriteFile(dir + '/image.png', 'fixture');
    safeWriteFile(dir + '/face.task', 'fixture');
  });
  afterEach(() => safeRmSync(dir, { recursive: true, force: true }));
  it('passes literal paths to the bounded offline helper without a shell', async () => {
    const runner = vi.fn(async () => ({
      status: 0,
      stdout: JSON.stringify(result(frame())),
      stderr: '',
    }));
    await expect(
      trackMedia({ path: dir + '/image.png', faceModel: dir + '/face.task' }, runner)
    ).resolves.toEqual(result(frame()));
    expect(runner).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining([
        '-I',
        '--input',
        dir + '/image.png',
        '--face-model',
        dir + '/face.task',
      ]),
      expect.objectContaining({
        timeoutMs: 120000,
        maxOutputMB: 12,
        env: expect.objectContaining({ HF_HUB_OFFLINE: '1' }),
      })
    );
  });
  it('rejects empty batch helper output instead of claiming successful perception', async () => {
    const request = { path: dir + '/image.png', faceModel: dir + '/face.task' };
    await expect(
      trackMedia(request, async () => ({ status: 0, stdout: JSON.stringify(result()), stderr: '' }))
    ).rejects.toThrow(/no frames/);
  });
  it('fails before running without models, for invalid budgets and outside inputs', async () => {
    const runner = vi.fn();
    await expect(trackMedia({ path: dir + '/image.png' }, runner)).rejects.toThrow(
      /TRACKING_MODEL_REQUIRED/
    );
    await expect(
      trackMedia(
        { path: dir + '/image.png', faceModel: dir + '/face.task', maxFrames: 301 },
        runner
      )
    ).rejects.toThrow(/maxFrames/);
    await expect(
      trackMedia({ path: '../secret.png', faceModel: dir + '/face.task' }, runner)
    ).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
  it('keeps MediaPipe resident, preserves source times and kills its process on close', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn(() => {
        child.killed = true;
        return true;
      }),
    });
    const spawn = vi.fn(() => ({
      resourceId: 'tracking-test',
      child: child as unknown as ChildProcess,
    }));
    child.stdin.on('data', (line) => {
      const input = JSON.parse(String(line));
      child.stdout.write(JSON.stringify(result(frame(input.time_sec))) + '\n');
    });
    const session = openTrackingSession({ faceModel: dir + '/face.task', maxFrames: 2 }, spawn);
    expect((await session.infer({ path: dir + '/image.png', time_sec: 1 })).time_sec).toBe(1);
    expect((await session.infer({ path: dir + '/image.png', time_sec: 2 })).time_sec).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(session.infer({ path: dir + '/image.png', time_sec: 3 })).rejects.toThrow(
      /budget/
    );
    session.close();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('cancels an in-flight resident request and rejects malformed/unsolicited output', async () => {
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn(() => {
        child.killed = true;
        return true;
      }),
    });
    const spawn = vi.fn(() => ({
      resourceId: 'tracking-test-abort',
      child: child as unknown as ChildProcess,
    }));
    const session = openTrackingSession(
      { faceModel: dir + '/face.task', signal: controller.signal },
      spawn
    );
    const pending = session.infer({ path: dir + '/image.png', time_sec: 1 });
    controller.abort();
    await expect(pending).rejects.toThrow(/TRACKING_ABORTED/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const other = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn(() => {
        other.killed = true;
        return true;
      }),
    });
    const malformed = openTrackingSession({ faceModel: dir + '/face.task' }, () => ({
      resourceId: 'tracking-test-invalid',
      child: other as unknown as ChildProcess,
    }));
    const rejected = malformed.infer({ path: dir + '/image.png', time_sec: 1 });
    other.stdout.write('not JSON\n');
    await expect(rejected).rejects.toThrow(/valid JSON/);
    expect(other.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('does not turn dependency failures, malformed output, or oversize output into empty detections', async () => {
    const request = { path: dir + '/image.png', faceModel: dir + '/face.task' };
    await expect(
      trackMedia(request, async () => ({ status: 1, stdout: '', stderr: 'mediapipe missing' }))
    ).rejects.toThrow(/TRACKING_UNAVAILABLE/);
    await expect(
      trackMedia(request, async () => ({ status: 0, stdout: 'not JSON', stderr: '' }))
    ).rejects.toThrow(/valid JSON/);
    await expect(
      trackMedia(request, async () => ({
        status: 0,
        stdout: ' '.repeat(12 * 1024 * 1024 + 1),
        stderr: '',
      }))
    ).rejects.toThrow(/output exceeded/);
  });
});

describe('governed captured-image tracking stream', () => {
  it('pulls one image per requested frame and stops without draining upstream', async () => {
    let pulls = 0;
    let closed = false;
    async function* source() {
      try {
        for (let i = 0; i < 10; i++) {
          pulls++;
          yield { path: 'captured.png', time_sec: i * 0.1 };
        }
      } finally {
        closed = true;
      }
    }
    const analyze = vi.fn(async () => result(frame()));
    const stream = trackFrameStream(source(), { faceModel: 'face.task', maxFrames: 2 }, analyze)[
      Symbol.asyncIterator
    ]();
    expect(pulls).toBe(0);
    expect((await stream.next()).value?.time_sec).toBe(0);
    expect(pulls).toBe(1);
    expect((await stream.next()).value?.time_sec).toBe(0.1);
    expect(pulls).toBe(2);
    expect((await stream.next()).done).toBe(true);
    expect(closed).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(2);
  });
  it('stops after cancellation without publishing a late result', async () => {
    const controller = new AbortController();
    async function* source() {
      yield { path: 'captured.png', time_sec: 0 };
    }
    const analyze = vi.fn(async () => {
      controller.abort();
      return result(frame());
    });
    const frames = [];
    for await (const f of trackFrameStream(
      source(),
      { faceModel: 'face.task', signal: controller.signal },
      analyze
    ))
      frames.push(f);
    expect(frames).toEqual([]);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it('cancels promptly while a captured-image producer has no new frames', async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<{ path: string; time_sec: number }>>(() => undefined),
          return: close,
        };
      },
    };
    const stream = trackFrameStream(
      source,
      { faceModel: 'face.task', signal: controller.signal },
      async () => result(frame())
    )[Symbol.asyncIterator]();
    const next = stream.next();
    await Promise.resolve();
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('refuses nonmonotonic source times', async () => {
    async function* source() {
      yield { path: 'a.png', time_sec: 1 };
      yield { path: 'b.png', time_sec: 0.5 };
    }
    const read = async () => {
      for await (const _f of trackFrameStream(source(), { faceModel: 'face.task' }, async () =>
        result(frame())
      )) {
        /* consume */
      }
    };
    await expect(read()).rejects.toThrow(/increasing/);
  });
});
