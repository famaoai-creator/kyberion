import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupRealtimeVoiceResources,
  smokeTestStreamingTts,
} from './realtime-voice-streaming-runtime.js';
import type { StreamingTextToSpeechBridge } from '@agent/core/voice/streaming-tts-bridge';
function fixture(next: () => Promise<IteratorResult<{ payload: Uint8Array }>>) {
  const release = vi.fn(async () => ({ done: true as const, value: undefined }));
  const dispose = vi.fn();
  const bridge = {
    bridge_id: 'fixture',
    format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
    dispose,
    synthesizeStream: () => ({ [Symbol.asyncIterator]: () => ({ next, return: release }) }),
  } as unknown as StreamingTextToSpeechBridge;
  return { bridge, release, dispose };
}
afterEach(() => {
  vi.useRealTimers();
});
describe('streaming TTS startup probe lifecycle', () => {
  it('clears its deadline after PCM arrives and releases the probe iterator', async () => {
    vi.useFakeTimers();
    const f = fixture(async () => ({ done: false, value: { payload: new Uint8Array([1, 2]) } }));
    expect(await smokeTestStreamingTts(f.bridge, 'fixture')).toEqual({ ok: true });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.dispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('disposes a timed-out worker and clears its deadline', async () => {
    vi.useFakeTimers();
    const f = fixture(() => new Promise(() => {}));
    const result = smokeTestStreamingTts(f.bridge, 'fixture', 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toEqual({ ok: false, reason: 'no PCM within 20ms' });
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('streaming cleanup failure isolation', () => {
  it('attempts every cleanup despite a synchronous throw and an asynchronous rejection', async () => {
    const attempts: string[] = [];
    await expect(
      cleanupRealtimeVoiceResources([
        {
          resource: 'throwing bridge',
          cleanup: () => {
            attempts.push('bridge');
            throw new Error('bridge shutdown failed');
          },
        },
        {
          resource: 'rejecting client',
          cleanup: async () => {
            attempts.push('client');
            throw new Error('client shutdown failed');
          },
        },
        {
          resource: 'registration',
          cleanup: () => {
            attempts.push('registration');
          },
        },
      ])
    ).resolves.toBeUndefined();
    expect(attempts).toEqual(['bridge', 'client', 'registration']);
  });

  it('retains a probe failure when bridge disposal and iterator return both throw', async () => {
    const f = fixture(async () => {
      throw new Error('primary probe failed');
    });
    f.dispose.mockImplementation(() => {
      throw new Error('secondary dispose failed');
    });
    f.release.mockImplementation(() => {
      throw new Error('secondary return failed');
    });
    expect(await smokeTestStreamingTts(f.bridge, 'fixture')).toEqual({
      ok: false,
      reason: 'primary probe failed',
    });
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('retains a probe failure when bridge disposal and iterator return reject asynchronously', async () => {
    const f = fixture(async () => {
      throw new Error('primary probe failed');
    });
    f.dispose.mockImplementation(() => Promise.reject(new Error('secondary dispose rejected')));
    f.release.mockRejectedValue(new Error('secondary return rejected'));
    expect(await smokeTestStreamingTts(f.bridge, 'fixture')).toEqual({
      ok: false,
      reason: 'primary probe failed',
    });
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(['sync', 'async'])(
    'retains successful PCM when iterator cleanup fails (%s)',
    async (kind) => {
      const f = fixture(async () => ({ done: false, value: { payload: new Uint8Array([1, 2]) } }));
      if (kind === 'sync')
        f.release.mockImplementation(() => {
          throw new Error('return failed');
        });
      else f.release.mockRejectedValue(new Error('return rejected'));
      expect(await smokeTestStreamingTts(f.bridge, 'fixture')).toEqual({ ok: true });
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.dispose).not.toHaveBeenCalled();
    }
  );
});
