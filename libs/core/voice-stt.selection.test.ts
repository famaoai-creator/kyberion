import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));
vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: () => null,
  pinSeamProviderDecision: () => undefined,
}));

const { pathResolver } = await import('./path-resolver.js');
const { safeRmSync } = await import('./secure-io.js');
const { setSeamSelectionRule } = await import('./seam-selection-rules.js');
const { resolveVoiceSttBackendOrder } = await import('./voice-stt.js');

const dir = pathResolver.sharedTmp('voice-hub-stt-selection-test');
const rulesFile = path.join(dir, 'rules.json');
const NO_PREFERENCE = {} as NodeJS.ProcessEnv;
const availability = {
  server: true,
  fluidAudio: false,
  fasterWhisper: false,
  mlxWhisper: true,
  whisperCpp: true,
  nativeSpeech: true,
};

describe('voice-hub STT order via the voice-hub-stt seam policy', () => {
  beforeEach(() => {
    record.mockClear();
    safeRmSync(dir, { recursive: true, force: true });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('keeps the platform order without a purpose or rule', () => {
    const order = resolveVoiceSttBackendOrder('auto', availability, NO_PREFERENCE);
    expect(order[0]).toBe('server');
    expect(order).toContain('native_speech');
    expect(record).not.toHaveBeenCalled();
  });

  it('ranks available backends by purpose and records the decision', () => {
    const privacy = resolveVoiceSttBackendOrder('auto', availability, NO_PREFERENCE, {
      purpose: 'privacy',
    });
    expect(privacy[0]).toBe('mlx_whisper');
    expect(privacy[privacy.length - 1]).toBe('server');
    expect(privacy).not.toContain('fluid_audio');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'voice-hub-stt/mlx_whisper' })
    );
    const latency = resolveVoiceSttBackendOrder('auto', availability, NO_PREFERENCE, {
      purpose: 'latency',
      record: false,
    });
    expect(latency[0]).toBe('native_speech');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit choices: requested backend and VOICE_HUB_STT_PREFERENCE', () => {
    expect(
      resolveVoiceSttBackendOrder('whisper_cpp', availability, NO_PREFERENCE, {
        purpose: 'privacy',
      })
    ).toEqual(['whisper_cpp']);
    expect(
      resolveVoiceSttBackendOrder(
        'auto',
        availability,
        { VOICE_HUB_STT_PREFERENCE: 'server,whisper_cpp' },
        { purpose: 'privacy' }
      )
    ).toEqual(['server', 'whisper_cpp']);
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects unknown purposes naming the known ones', () => {
    expect(() =>
      resolveVoiceSttBackendOrder('auto', availability, NO_PREFERENCE, { purpose: 'cheap' })
    ).toThrow(/unknown purpose 'cheap'.*known: accuracy, latency, privacy/);
  });

  it('puts an operator rule first for its language and keeps the platform order after it', () => {
    setSeamSelectionRule({
      rule_id: 'ja-hub',
      seam: 'voice-hub-stt',
      when: { context: { language: 'ja' } },
      prefer: ['fluid_audio', 'whisper_cpp', 'mlx_whisper'],
      set_by: 'user:test',
    });
    const base = resolveVoiceSttBackendOrder('auto', availability, NO_PREFERENCE);
    const ja = resolveVoiceSttBackendOrder('auto', availability, NO_PREFERENCE, {
      context: { language: 'ja' },
    });
    expect(ja.slice(0, 2)).toEqual(['whisper_cpp', 'mlx_whisper']);
    expect(ja.slice(2)).toEqual(base.filter((id) => id !== 'whisper_cpp' && id !== 'mlx_whisper'));
    record.mockClear();
    const en = resolveVoiceSttBackendOrder('auto', availability, NO_PREFERENCE, {
      context: { language: 'en' },
    });
    expect(en).toEqual(base);
    // No matching rule: no selection ran, so nothing was recorded.
    expect(record).not.toHaveBeenCalled();
  });
});
