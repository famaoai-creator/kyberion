import { describe, expect, it } from 'vitest';
import {
  resolveSpeculativePolicy,
  transcriptsMatchForSpeculation,
} from './voice-speculative-policy.js';

describe('resolveSpeculativePolicy', () => {
  it('is disabled by default with the documented timings', () => {
    expect(resolveSpeculativePolicy({ env: {} })).toEqual({
      enabled: false,
      tentativeSilenceMs: 250,
      minPartialChars: 4,
      disabled_reason: 'default_off',
    });
  });

  it('is enabled by an explicit option or the env flag', () => {
    expect(resolveSpeculativePolicy({ option: true, env: {} }).enabled).toBe(true);
    expect(
      resolveSpeculativePolicy({ env: { KYBERION_VOICE_SPECULATIVE_REPLY: '1' } }).enabled
    ).toBe(true);
    expect(
      resolveSpeculativePolicy({ option: false, env: { KYBERION_VOICE_SPECULATIVE_REPLY: '1' } })
        .enabled
    ).toBe(false);
    expect(
      resolveSpeculativePolicy({ env: { KYBERION_VOICE_SPECULATIVE_REPLY: '0' } }).enabled
    ).toBe(false);
  });

  it('is forced off on battery power or metered backends', () => {
    expect(resolveSpeculativePolicy({ option: true, powerSource: 'battery' })).toMatchObject({
      enabled: false,
      disabled_reason: 'battery',
    });
    expect(resolveSpeculativePolicy({ option: true, costTier: 'metered' })).toMatchObject({
      enabled: false,
      disabled_reason: 'metered',
    });
    expect(
      resolveSpeculativePolicy({ option: true, powerSource: 'ac', costTier: 'free' }).enabled
    ).toBe(true);
    expect(resolveSpeculativePolicy({ option: true, powerSource: 'unknown' }).enabled).toBe(true);
  });

  it('rejects invalid tuning', () => {
    expect(() => resolveSpeculativePolicy({ tentativeSilenceMs: -1 })).toThrow(
      /tentativeSilenceMs/
    );
  });
});

describe('transcriptsMatchForSpeculation', () => {
  it('ignores punctuation, case, width and whitespace', () => {
    expect(transcriptsMatchForSpeculation('明日の会議は何時', '明日の会議は何時？')).toBe(true);
    expect(transcriptsMatchForSpeculation('What time is it', 'what time is it?')).toBe(true);
    expect(transcriptsMatchForSpeculation('ＡＢＣ', 'abc')).toBe(true);
  });

  it('rejects diverging or empty transcripts', () => {
    expect(transcriptsMatchForSpeculation('明日の会議', '明日の会議で資料を')).toBe(false);
    expect(transcriptsMatchForSpeculation('', '')).toBe(false);
  });
});
