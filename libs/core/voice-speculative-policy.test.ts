import { describe, expect, it } from 'vitest';
import {
  costTierForReasoningMode,
  detectVoicePowerSource,
  resolveSpeculativePolicy,
  transcriptsMatchForSpeculation,
} from './voice-speculative-policy.js';

describe('detectVoicePowerSource', () => {
  const pmset = (stdout: string, status: number | null = 0) => {
    const calls: string[][] = [];
    return {
      calls,
      exec: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { stdout, status };
      },
    };
  };

  it('reads the macOS power source from pmset', () => {
    const battery = pmset(
      "Now drawing from 'Battery Power'\n -InternalBattery-0\t80%; discharging"
    );
    expect(detectVoicePowerSource({ platform: 'darwin', exec: battery.exec })).toBe('battery');
    expect(battery.calls).toEqual([['pmset', '-g', 'batt']]);
    expect(
      detectVoicePowerSource({
        platform: 'darwin',
        exec: pmset("Now drawing from 'AC Power'").exec,
      })
    ).toBe('ac');
  });

  it('is unknown off macOS, on probe failure, or on unrecognised output', () => {
    const probe = pmset("Now drawing from 'Battery Power'");
    expect(detectVoicePowerSource({ platform: 'linux', exec: probe.exec })).toBe('unknown');
    expect(probe.calls).toEqual([]);
    expect(detectVoicePowerSource({ platform: 'darwin', exec: pmset('', 1).exec })).toBe('unknown');
    expect(detectVoicePowerSource({ platform: 'darwin', exec: pmset('garbage').exec })).toBe(
      'unknown'
    );
    expect(
      detectVoicePowerSource({
        platform: 'darwin',
        exec: () => {
          throw new Error('[POLICY_BLOCKED]');
        },
      })
    ).toBe('unknown');
  });
});

describe('costTierForReasoningMode', () => {
  it('treats local and subscription CLI backends as free, everything else as metered', () => {
    expect(costTierForReasoningMode('claude-cli')).toBe('free');
    expect(costTierForReasoningMode('ollama')).toBe('free');
    expect(costTierForReasoningMode('anthropic')).toBe('metered');
    expect(costTierForReasoningMode('openrouter')).toBe('metered');
    expect(costTierForReasoningMode(null)).toBe('metered');
    expect(costTierForReasoningMode('something-new')).toBe('metered');
  });
});

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
