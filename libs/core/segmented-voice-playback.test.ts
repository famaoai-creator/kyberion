import { describe, expect, it } from 'vitest';

import { speakSegmented } from './segmented-voice-playback.js';
import type { PlaybackHandle, PlaybackResult } from './audio-playback.js';

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
});
