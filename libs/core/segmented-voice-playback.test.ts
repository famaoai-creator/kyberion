import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

import { speakSegmented } from './segmented-voice-playback.js';
import type { PlaybackHandle, PlaybackResult } from './audio-playback.js';

interface FakeChild extends EventEmitter {
  stdout: null;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = null;
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn(() => child.exitCode === null);
  return child;
}

function closeFakeChild(child: FakeChild, code = 0): void {
  child.exitCode = code;
  child.emit('close', code);
}

function immediateHandle(): PlaybackHandle {
  const done = Promise.resolve<PlaybackResult>({ ok: true, interrupted: false });
  return { done, stop: async () => ({ ok: true, interrupted: true }) };
}

function pendingHandle(): PlaybackHandle & { finish(): void } {
  let resolveDone: (r: PlaybackResult) => void = () => undefined;
  const done = new Promise<PlaybackResult>((resolve) => {
    resolveDone = resolve;
  });
  return {
    done,
    stop: async () => {
      resolveDone({ ok: true, interrupted: true });
      return done;
    },
    finish: () => resolveDone({ ok: true, interrupted: false }),
  };
}

describe('speakSegmented', () => {
  it('splits into sentence segments and plays them in order', async () => {
    const synthesized: string[] = [];
    const played: string[] = [];
    const controller = speakSegmented({
      text: '最初の文です。次の文です。最後の文です。',
      maxSegmentChars: 10,
      synthesize: async (segment, index) => {
        synthesized.push(segment);
        return `/tmp/seg-${index}.wav`;
      },
      play: (audioPath) => {
        played.push(audioPath);
        return immediateHandle();
      },
    });
    const result = await controller.done;

    expect(result.completed).toBe(true);
    expect(result.interrupted).toBe(false);
    expect(synthesized).toHaveLength(3);
    expect(played).toEqual(['/tmp/seg-0.wav', '/tmp/seg-1.wav', '/tmp/seg-2.wav']);
    expect(result.metrics.segments_total).toBe(3);
    expect(result.metrics.segments_spoken).toBe(3);
    expect(result.metrics.first_audio_ms).not.toBeNull();
  });

  it('synthesizes segment N+1 while segment N is still playing', async () => {
    const events: string[] = [];
    const handles: Array<PlaybackHandle & { finish(): void }> = [];
    const controller = speakSegmented({
      text: 'ひとつめの文です。ふたつめの文です。',
      maxSegmentChars: 12,
      synthesize: async (_segment, index) => {
        events.push(`synth-${index}`);
        return `/tmp/seg-${index}.wav`;
      },
      play: () => {
        const handle = pendingHandle();
        handles.push(handle);
        events.push(`play-${handles.length - 1}`);
        return handle;
      },
    });

    // While segment 0 is still playing (unfinished), segment 1's
    // synthesis must already be requested — that's the overlap.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toContain('play-0');
    expect(events).toContain('synth-1');
    expect(events).not.toContain('play-1');
    handles[0].finish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    handles[1].finish();

    const result = await controller.done;
    expect(result.completed).toBe(true);
    // synth-1 was requested while play-0 was still pending — the overlap.
    expect(events.indexOf('synth-1')).toBeGreaterThan(events.indexOf('synth-0'));
    expect(events.indexOf('play-1')).toBeGreaterThan(events.indexOf('synth-1'));
  });

  it('stop() interrupts playback and skips the remaining segments', async () => {
    const played: string[] = [];
    const handle = pendingHandle();
    const controller = speakSegmented({
      text: 'ひとつめの文です。ふたつめの文です。みっつめの文です。',
      maxSegmentChars: 12,
      synthesize: async (_segment, index) => `/tmp/seg-${index}.wav`,
      play: (audioPath) => {
        played.push(audioPath);
        return handle;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await controller.stop();

    expect(result.interrupted).toBe(true);
    expect(result.completed).toBe(false);
    expect(played).toEqual(['/tmp/seg-0.wav']);
    expect(result.metrics.segments_total).toBe(3);
  });

  it('surfaces synthesis failure as an error result', async () => {
    const controller = speakSegmented({
      text: 'これは失敗するはずの文です。',
      synthesize: async () => {
        throw new Error('engine exploded');
      },
      play: () => immediateHandle(),
    });
    const result = await controller.done;
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/engine exploded/);
  });

  it('returns promptly when synthesis is still pending at stop time', async () => {
    const controller = speakSegmented({
      text: '停止可能な合成です。',
      synthesize: (_segment, _index, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      play: () => immediateHandle(),
    });

    const result = await controller.stop();
    expect(result.interrupted).toBe(true);
    expect(result.completed).toBe(false);
  });

  it('pause() stops a non-pausable segment and replays it from the start on resume()', async () => {
    const played: string[] = [];
    const first = pendingHandle();
    let stops = 0;
    const segmentStarts: number[] = [];
    const controller = speakSegmented({
      text: 'ひとつめの文です。ふたつめの文です。',
      maxSegmentChars: 12,
      synthesize: async (_segment, index) => `/tmp/seg-${index}.wav`,
      play: (audioPath) => {
        played.push(audioPath);
        if (played.length > 1) return immediateHandle();
        return {
          done: first.done,
          stop: () => {
            stops += 1;
            return first.stop();
          },
        };
      },
      onSegmentStart: ({ index }) => segmentStarts.push(index),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(played).toEqual(['/tmp/seg-0.wav']);

    controller.pause?.();
    controller.pause?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The current sentence is silenced, not left playing into the mic.
    expect(stops).toBe(1);
    expect(played).toEqual(['/tmp/seg-0.wav']);

    controller.resume?.();
    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(played).toEqual(['/tmp/seg-0.wav', '/tmp/seg-0.wav', '/tmp/seg-1.wav']);
    expect(segmentStarts).toEqual([0, 1]);
    expect(result.metrics.segments_spoken).toBe(2);
  });

  it('pause() pauses a pausable handle in place and resume() continues it', async () => {
    const played: string[] = [];
    const calls: string[] = [];
    const first = pendingHandle();
    const controller = speakSegmented({
      text: 'ひとつめの文です。ふたつめの文です。',
      maxSegmentChars: 12,
      synthesize: async (_segment, index) => `/tmp/seg-${index}.wav`,
      play: (audioPath) => {
        played.push(audioPath);
        if (played.length > 1) return immediateHandle();
        return {
          ...first,
          pause: () => calls.push('pause'),
          resume: () => calls.push('resume'),
        };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.pause?.();
    expect(calls).toEqual(['pause']);
    controller.resume?.();
    expect(calls).toEqual(['pause', 'resume']);
    first.finish();
    const result = await controller.done;
    expect(result.completed).toBe(true);
    expect(played).toEqual(['/tmp/seg-0.wav', '/tmp/seg-1.wav']);
  });

  it('stop() while paused ends without replaying the stopped segment', async () => {
    const played: string[] = [];
    const controller = speakSegmented({
      text: 'ひとつめの文です。ふたつめの文です。',
      maxSegmentChars: 12,
      synthesize: async (_segment, index) => `/tmp/seg-${index}.wav`,
      play: (audioPath) => {
        played.push(audioPath);
        return pendingHandle();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.pause?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await controller.stop();
    expect(result.interrupted).toBe(true);
    expect(played).toEqual(['/tmp/seg-0.wav']);
  });

  it('uses the default player (playAudioFile) in-place pause() instead of stop-and-replay', async () => {
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      children.push(child);
      return child;
    });

    const controller = speakSegmented({
      text: 'ひとつめの文です。ふたつめの文です。',
      maxSegmentChars: 12,
      synthesize: async (_segment, index) => `/tmp/seg-${index}.wav`,
      // No `play` override: exercises the real default (playAudioFile).
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(children).toHaveLength(1);

    controller.pause?.();
    expect(children[0].kill).toHaveBeenCalledWith('SIGSTOP');
    controller.resume?.();
    expect(children[0].kill).toHaveBeenLastCalledWith('SIGCONT');

    closeFakeChild(children[0], 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(children).toHaveLength(2);
    closeFakeChild(children[1], 0);

    const result = await controller.done;
    expect(result.completed).toBe(true);
    // Segment 0 was paused/resumed in place, not stopped and replayed.
    expect(children).toHaveLength(2);
  });
});
