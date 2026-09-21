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
const {
  _resetVoiceEngineRegistryCacheForTests,
  detectTextLanguage,
  getVoiceEngineRecord,
  listVoiceEngines,
  normalizeLanguageTag,
  selectVoiceTtsEngine,
  unmetVoiceTtsRequirements,
  voiceEngineSupportsLanguage,
  VoiceTtsEngineSelectionError,
} = await import('./voice-engine-registry.js');

const dir = pathResolver.sharedTmp('voice-tts-engine-selection-test');
const rulesFile = path.join(dir, 'rules.json');
const ids = (engines: Array<{ engine_id: string }>) => engines.map((engine) => engine.engine_id);

describe('voice-tts-engine selection', () => {
  beforeEach(() => {
    record.mockClear();
    safeRmSync(dir, { recursive: true, force: true });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
    _resetVoiceEngineRegistryCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(dir, { recursive: true, force: true });
    _resetVoiceEngineRegistryCacheForTests();
  });

  it('detects the text language from its script', () => {
    expect(detectTextLanguage('こんにちは、世界')).toBe('ja');
    expect(detectTextLanguage('東京タワー')).toBe('ja');
    expect(detectTextLanguage('안녕하세요')).toBe('ko');
    expect(detectTextLanguage('你好世界')).toBe('zh');
    expect(detectTextLanguage('Hello world')).toBe('en');
    expect(detectTextLanguage('')).toBe('en');
    expect(normalizeLanguageTag('ja-JP')).toBe('ja');
    expect(normalizeLanguageTag('ZH_hans')).toBe('zh');
    expect(normalizeLanguageTag(undefined)).toBe('');
  });

  it('declares languages on every governed engine', () => {
    for (const engine of listVoiceEngines('all')) {
      expect(engine.languages?.length, engine.engine_id).toBeGreaterThan(0);
    }
    expect(getVoiceEngineRecord('local_say').languages).toEqual(['*']);
    expect(getVoiceEngineRecord('pocket_tts').languages).not.toContain('ja');
    expect(voiceEngineSupportsLanguage(getVoiceEngineRecord('local_say'), 'ko')).toBe(true);
    expect(voiceEngineSupportsLanguage(getVoiceEngineRecord('kokoro'), 'ja-JP')).toBe(true);
    expect(
      voiceEngineSupportsLanguage({ ...getVoiceEngineRecord('kokoro'), languages: undefined }, 'ko')
    ).toBe(true);
  });

  it('gives short unmet reasons for hard requirements', () => {
    expect(
      unmetVoiceTtsRequirements(getVoiceEngineRecord('pocket_tts'), { language: 'ja' })
    ).toEqual(['language ja']);
    expect(
      unmetVoiceTtsRequirements(getVoiceEngineRecord('mlx_audio_qwen3'), {
        platform: 'linux',
        format: 'aiff',
        identity: 'stock',
      })
    ).toEqual(['platform linux', 'format aiff', 'would clone the profile voice (identity guard)']);
    expect(
      unmetVoiceTtsRequirements(getVoiceEngineRecord('local_say'), { identity: 'clone' })
    ).toEqual(['voice_clone (identity guard)']);
    expect(
      unmetVoiceTtsRequirements(getVoiceEngineRecord('gemini_tts'), { localOnly: true })
    ).toEqual(['no runtime adapter (external_provider)', 'local_only']);
  });

  it('ranks engines that can speak the language by purpose', () => {
    const { engines, decision } = selectVoiceTtsEngine({
      purpose: 'naturalness',
      requires: { language: 'ja', platform: 'darwin' },
    });
    expect(ids(engines)).toEqual(['mlx_audio_qwen3', 'kokoro', 'local_say', 'espeak_ng']);
    expect(decision.strategy).toBe('purpose');
    expect(decision.context).toEqual({ language: 'ja' });
    expect(decision.excluded.find((entry) => entry.id === 'pocket_tts')?.unmet).toEqual([
      'language ja',
    ]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('keeps the identity class: stock requests never pick a clone engine', () => {
    const { engines } = selectVoiceTtsEngine({
      purpose: 'naturalness',
      requires: { language: 'ja', platform: 'darwin', identity: 'stock' },
    });
    expect(ids(engines)).toEqual(['kokoro', 'local_say', 'espeak_ng']);
  });

  it('uses the seam default without a purpose and the fallback purpose when it cannot run', () => {
    expect(selectVoiceTtsEngine({ requires: { language: 'en' } }).decision.strategy).toBe(
      'default'
    );
    const fallback = selectVoiceTtsEngine({
      requires: { language: 'en', platform: 'darwin', identity: 'clone' },
    });
    expect(fallback.decision.strategy).toBe('fallback');
    expect(ids(fallback.engines)).toEqual(['pocket_tts', 'mlx_audio_qwen3']);
    expect(fallback.decision.decision_key).toBe('default');
  });

  it('fails with the audited decision when nothing can run the request', () => {
    try {
      selectVoiceTtsEngine({ requires: { language: 'ja', platform: 'linux', identity: 'clone' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceTtsEngineSelectionError);
      expect((error as InstanceType<typeof VoiceTtsEngineSelectionError>).decision.strategy).toBe(
        'unresolved'
      );
    }
  });

  it('names known purposes for an unknown purpose', () => {
    expect(() => selectVoiceTtsEngine({ purpose: 'loudness' })).toThrow(
      /unknown purpose 'loudness'.*known: latency, naturalness, privacy/
    );
  });

  it('applies operator rules matched on the request language', () => {
    setSeamSelectionRule({
      rule_id: 'ja-kokoro',
      seam: 'voice-tts-engine',
      when: { context: { language: 'ja' } },
      prefer: ['kokoro'],
      set_by: 'user:test',
    });
    const ja = selectVoiceTtsEngine({ requires: { language: 'ja', platform: 'darwin' } });
    expect(ja.decision.strategy).toBe('rule');
    expect(ja.engines[0]?.engine_id).toBe('kokoro');
    const en = selectVoiceTtsEngine({ requires: { language: 'en', platform: 'darwin' } });
    expect(en.decision.strategy).toBe('default');
  });
});
