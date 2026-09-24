import { describe, expect, it } from 'vitest';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import { countBargeInWords, TwoStageBargeIn } from './two-stage-barge-in.js';

const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 };

function chunk(amplitude: number, durationMs = 50): AudioChunk {
  const payload = new Uint8Array((format.sample_rate_hz * durationMs * 2) / 1000);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, amplitude, true);
  }
  return { format, payload, ts_ms: 0 };
}

function harness(options: Partial<ConstructorParameters<typeof TwoStageBargeIn>[0]> = {}) {
  let clock = 0;
  const bargeIn = new TwoStageBargeIn({
    base_rms_threshold: 800,
    streaming_stt: true,
    now: () => clock,
    ...options,
  });
  return {
    bargeIn,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('countBargeInWords', () => {
  it('counts Latin words and skips fillers', () => {
    expect(countBargeInWords('um uh')).toBe(0);
    expect(countBargeInWords('wait, stop')).toBe(2);
  });

  it('counts Japanese without spaces and ignores fillers', () => {
    expect(countBargeInWords('えーと')).toBe(0);
    expect(countBargeInWords('うん、うん')).toBe(0);
    expect(countBargeInWords('あのー')).toBe(0);
    expect(countBargeInWords('待って')).toBeGreaterThanOrEqual(1);
    expect(countBargeInWords('えーと、止めて')).toBeGreaterThanOrEqual(1);
  });
});

describe('TwoStageBargeIn', () => {
  it('pauses on sustained energy and hard-stops once a partial has words', () => {
    const { bargeIn, advance } = harness();
    expect(bargeIn.observeAudio(chunk(3_000))).toEqual([]);
    expect(bargeIn.observeAudio(chunk(3_000))).toEqual([]);
    expect(bargeIn.observeAudio(chunk(3_000))).toEqual([{ type: 'pause_tts' }]);
    advance(50);
    bargeIn.observeAudio(chunk(3_000));
    expect(bargeIn.bufferedChunks()).toHaveLength(4);
    expect(bargeIn.observePartial('えーと')).toEqual([]);
    expect(bargeIn.observePartial('ちょっと待って')).toEqual([
      { type: 'hard_stop', words: 'ちょっと待って' },
    ]);
    expect(bargeIn.bufferedChunks()).toHaveLength(4);
    expect(bargeIn.observeAudio(chunk(3_000))).toEqual([]);
    bargeIn.reset();
    expect(bargeIn.bufferedChunks()).toEqual([]);
  });

  it('resumes playback when the partial is an echo of the assistant', () => {
    const { bargeIn } = harness({ isEcho: (text) => text.includes('天気') });
    bargeIn.observeVadStart();
    expect(bargeIn.observePartial('明日の天気は晴れ')).toEqual([
      { type: 'resume_tts', reason: 'echo' },
    ]);
    expect(bargeIn.state).toBe('listening');
  });

  it('resumes after the words grace window when no words arrive', () => {
    const { bargeIn, advance } = harness();
    expect(bargeIn.observeVadStart()).toEqual([{ type: 'pause_tts' }]);
    advance(599);
    expect(bargeIn.tick()).toEqual([]);
    advance(1);
    expect(bargeIn.tick()).toEqual([{ type: 'resume_tts', reason: 'no_words' }]);
  });

  it('a tick applies queued word partials before grace expiry can resume', () => {
    const pausedAtExpiry = () => {
      const h = harness();
      for (let i = 0; i < 3; i += 1) h.bargeIn.observeAudio(chunk(3_000));
      expect(h.bargeIn.state).toBe('paused');
      h.advance(600);
      return h.bargeIn;
    };
    // Audio first (the old order) resumes and then drops the words.
    const audioFirst = pausedAtExpiry();
    const lost = [
      ...audioFirst.observeAudio(chunk(3_000)),
      ...audioFirst.observePartial('wait stop'),
    ];
    expect(lost).toEqual([{ type: 'resume_tts', reason: 'no_words' }]);

    const bargeIn = pausedAtExpiry();
    expect(bargeIn.observeTick(chunk(3_000), ['wait stop'])).toEqual([
      { type: 'hard_stop', words: 'wait stop' },
    ]);
    expect(bargeIn.state).toBe('stopped');
    expect(bargeIn.bufferedChunks()).toHaveLength(4);
  });

  it('a tick without partials behaves like observeAudio', () => {
    const { bargeIn, advance } = harness();
    for (let i = 0; i < 3; i += 1) bargeIn.observeTick(chunk(3_000), []);
    advance(600);
    expect(bargeIn.observeTick(chunk(3_000), ['um'])).toEqual([
      { type: 'resume_tts', reason: 'no_words' },
    ]);
  });

  it('ignores a VAD onset below the barge-in threshold', () => {
    const { bargeIn } = harness();
    expect(bargeIn.observeVadStart(1_000)).toEqual([]);
    expect(bargeIn.observeVadStart(2_000)).toEqual([{ type: 'pause_tts' }]);
  });

  it('falls back to a hard stop after sustained speech without streaming STT', () => {
    const { bargeIn, advance } = harness({ streaming_stt: false });
    bargeIn.observeVadStart();
    advance(650);
    expect(bargeIn.tick()).toEqual([]);
    advance(50);
    expect(bargeIn.tick()).toEqual([{ type: 'hard_stop', words: '' }]);
  });

  it('without streaming STT, a short burst resumes after the grace window', () => {
    const { bargeIn, advance } = harness({ streaming_stt: false });
    bargeIn.observeVadStart();
    advance(200);
    bargeIn.observeVadEnd();
    advance(400);
    expect(bargeIn.tick()).toEqual([{ type: 'resume_tts', reason: 'no_words' }]);
  });

  it('fallback also works from raw audio chunks', () => {
    const { bargeIn, advance } = harness({ streaming_stt: false });
    const actions = [];
    for (let i = 0; i < 14; i += 1) {
      actions.push(...bargeIn.observeAudio(chunk(3_000)));
      advance(50);
    }
    expect(actions).toEqual([{ type: 'pause_tts' }, { type: 'hard_stop', words: '' }]);
  });

  it('rejects unsafe tuning', () => {
    expect(() => harness({ words_grace_ms: 0 })).toThrow(/words_grace_ms/);
    expect(() => harness({ min_confirm_words: 0 })).toThrow(/min_confirm_words/);
    expect(() => harness({ fallback_hard_stop_speech_ms: 100 })).toThrow(/fallback/);
  });
});
