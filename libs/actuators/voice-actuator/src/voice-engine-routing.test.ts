import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  pinWrites: vi.fn(),
  profile: {} as Record<string, unknown>,
  renderNativeArtifact: vi.fn(
    async (_text: string, options: { requestId: string; format: string }) =>
      `/tmp/voice-generation/${options.requestId}.${options.format}`
  ),
  performPlayback: vi.fn(async () => ({ playback_source_path: undefined, outputs: [] })),
}));

vi.mock('@agent/core/audit-chain', () => ({
  auditChain: { record: (...args: unknown[]) => mocks.record(...args) },
}));
vi.mock('@agent/core/provider-pins-store', () => ({
  loadSeamProviderPin: () => null,
  pinSeamProviderDecision: (...args: unknown[]) => mocks.pinWrites(...args),
}));
vi.mock('@agent/core/src/trace', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/src/trace')>('@agent/core/src/trace');
  return { ...actual, persistTrace: vi.fn(() => 'trace-not-persisted-in-tests') };
});
vi.mock('@agent/core/voice-profile-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/voice-profile-registry')>(
    '@agent/core/voice-profile-registry'
  );
  return { ...actual, getVoiceProfileRecord: () => mocks.profile };
});
vi.mock('./voice-runtime-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('./voice-runtime-helpers.js')>(
    './voice-runtime-helpers.js'
  );
  return {
    ...actual,
    renderNativeArtifact: mocks.renderNativeArtifact,
    performPlayback: mocks.performPlayback,
  };
});

const { getVoiceEngineRecord } = await import('@agent/core/voice-engine-registry');
const { pathResolver } = await import('@agent/core/path-resolver');
const { safeRmSync } = await import('@agent/core/secure-io');
const { setSeamSelectionRule } = await import('@agent/core/seam-selection-rules');
const { routeVoiceEngine } = await import('./voice-engine-selection.js');
const { handleAction } = await import('./index.js');
type ActionInput = Parameters<typeof handleAction>[0];
/** Loosely typed op result: tests read a few known fields. */
type VoiceResult = Record<string, unknown> & {
  status?: string;
  warnings?: string[];
  reason?: string;
};

const rulesDir = pathResolver.sharedTmp('voice-engine-routing-test');
const originalPlatform = process.platform;
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value });

const generate = (overrides: Record<string, unknown> = {}) =>
  handleAction({
    action: 'generate_voice',
    request_id: 'route-1',
    text: 'こんにちは、今日の予定を確認します。',
    profile_ref: { profile_id: 'fixture' },
    engine: { engine_id: 'auto' },
    rendering: {
      language: 'ja',
      chunking: { max_chunk_chars: 200, crossfade_ms: 0, preserve_paralinguistic_tags: true },
    },
    delivery: { mode: 'artifact', format: 'wav', emit_progress_packets: false },
    ...overrides,
  } as unknown as ActionInput) as Promise<VoiceResult>;

describe('voice-tts-engine routing', () => {
  beforeEach(() => {
    mocks.record.mockClear();
    mocks.pinWrites.mockClear();
    mocks.renderNativeArtifact.mockClear();
    mocks.performPlayback.mockClear();
    mocks.profile = {
      profile_id: 'fixture',
      display_name: 'Fixture',
      tier: 'public',
      languages: ['ja'],
      default_engine_id: 'pocket_tts',
      status: 'active',
    };
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', `${rulesDir}/rules.json`);
    safeRmSync(rulesDir, { recursive: true, force: true });
  });
  afterEach(() => {
    setPlatform(originalPlatform);
    vi.unstubAllEnvs();
    safeRmSync(rulesDir, { recursive: true, force: true });
  });

  describe('routeVoiceEngine', () => {
    it('keeps the baseline without purpose, rules or unmet requirements (no audit)', () => {
      const routing = routeVoiceEngine({
        text: 'Hello there',
        baselineEngine: getVoiceEngineRecord('local_say'),
        explicit: false,
        requires: { platform: 'linux' },
      });
      expect(routing.engine.engine_id).toBe('local_say');
      expect(routing.language).toBe('en');
      expect(routing.language_source).toBe('detected');
      expect(routing.selection).toBeUndefined();
      expect(mocks.record).not.toHaveBeenCalled();
    });

    it('lets a named engine win and only warns about its language', () => {
      const routing = routeVoiceEngine({
        text: 'こんにちは',
        baselineEngine: getVoiceEngineRecord('pocket_tts'),
        explicit: true,
        purpose: 'naturalness',
        requires: { platform: 'linux' },
      });
      expect(routing.engine.engine_id).toBe('pocket_tts');
      expect(routing.selection).toBeUndefined();
      expect(routing.warnings).toEqual([
        "purpose 'naturalness' ignored: engine 'pocket_tts' was named explicitly",
        "engine 'pocket_tts' does not declare language 'ja' (detected); kept because it was named explicitly",
      ]);
    });

    it('falls back when the default engine cannot speak the language', () => {
      const routing = routeVoiceEngine({
        text: 'こんにちは',
        baselineEngine: getVoiceEngineRecord('pocket_tts'),
        explicit: false,
        requires: { platform: 'linux' },
      });
      expect(routing.engine.engine_id).toBe('kokoro');
      expect(routing.selection).toMatchObject({
        trigger: 'fallback',
        strategy: 'purpose',
        purpose: 'privacy',
      });
      expect(routing.candidateEngineIds).toEqual(['kokoro', 'local_say', 'espeak_ng']);
      expect(routing.warnings[0]).toMatch(/'pocket_tts' cannot run this request \(language ja\)/);
    });

    it('identity guard: never switches a personal clone engine for preference', () => {
      const routing = routeVoiceEngine({
        text: 'Good morning',
        baselineEngine: getVoiceEngineRecord('pocket_tts'),
        explicit: false,
        purpose: 'naturalness',
        requires: { platform: 'darwin', identity: 'clone' },
        personalVoiceLocked: true,
      });
      expect(routing.engine.engine_id).toBe('pocket_tts');
      expect(routing.warnings[0]).toMatch(/identity guard keeps personal voice engine/);
      expect(mocks.record).not.toHaveBeenCalled();
    });

    it('identity guard: switches only to another clone engine, else blocks', () => {
      const darwin = routeVoiceEngine({
        text: 'こんにちは',
        baselineEngine: getVoiceEngineRecord('pocket_tts'),
        explicit: false,
        requires: { platform: 'darwin', identity: 'clone' },
        personalVoiceLocked: true,
      });
      expect(darwin.engine.engine_id).toBe('mlx_audio_qwen3');
      expect(darwin.candidateEngineIds).toEqual(['mlx_audio_qwen3']);
      // Reference samples of a personal voice never go to a cloud clone engine.
      const cloudClone = darwin.selection?.excluded.find((entry) => entry.id === 'gemini_tts');
      expect(cloudClone?.unmet).toContain('local_only');
      const linux = routeVoiceEngine({
        text: 'こんにちは',
        baselineEngine: getVoiceEngineRecord('pocket_tts'),
        explicit: false,
        requires: { platform: 'linux', identity: 'clone' },
        personalVoiceLocked: true,
      });
      expect(linux.engine.engine_id).toBe('pocket_tts');
      expect(linux.blocked).toMatch(/no other clone engine can/);
    });

    it('applies a matching operator rule without a purpose, ignores a non-matching one', () => {
      setSeamSelectionRule({
        rule_id: 'ja-espeak',
        seam: 'voice-tts-engine',
        when: { context: { language: 'ja' } },
        prefer: ['espeak_ng'],
        set_by: 'user:test',
      });
      const english = routeVoiceEngine({
        text: 'Hello',
        baselineEngine: getVoiceEngineRecord('kokoro'),
        explicit: false,
        requires: { platform: 'linux' },
      });
      expect(english.engine.engine_id).toBe('kokoro');
      expect(english.selection).toBeUndefined();
      expect(mocks.record).not.toHaveBeenCalled();
      const japanese = routeVoiceEngine({
        text: 'こんにちは',
        baselineEngine: getVoiceEngineRecord('kokoro'),
        explicit: false,
        requires: { platform: 'linux' },
      });
      expect(japanese.engine.engine_id).toBe('espeak_ng');
      expect(japanese.selection).toMatchObject({
        trigger: 'rules',
        strategy: 'rule',
        rule_id: 'ja-espeak',
      });
    });

    it('rejects unknown purposes naming the known ones', () => {
      expect(() =>
        routeVoiceEngine({
          text: 'hi',
          baselineEngine: getVoiceEngineRecord('local_say'),
          explicit: false,
          purpose: 'cheap',
        })
      ).toThrow(/unknown purpose 'cheap'.*known: latency, naturalness, privacy/);
    });
  });

  describe('generate_voice', () => {
    it("routes engine 'auto' away from a default that cannot speak Japanese", async () => {
      setPlatform('linux');
      const result = await generate();
      expect(result.status).toBe('succeeded');
      expect(result.engine_id).toBe('pocket_tts');
      expect(result.resolved_engine_id).toBe('kokoro');
      expect(result.engine_selection).toMatchObject({ trigger: 'fallback', purpose: 'privacy' });
      expect(mocks.renderNativeArtifact).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          engineId: 'kokoro',
          candidateEngineIds: ['kokoro', 'local_say', 'espeak_ng'],
        })
      );
      expect(mocks.pinWrites).not.toHaveBeenCalled();
    });

    it('keeps a named engine (explicit wins) and reports the language mismatch', async () => {
      setPlatform('linux');
      const result = await generate({ engine: { engine_id: 'pocket_tts' } });
      expect(result.status).toBe('succeeded');
      expect(result.resolved_engine_id).toBe('pocket_tts');
      expect(result.engine_selection).toBeUndefined();
      expect(result.warnings[0]).toMatch(/does not declare language 'ja' \(explicit\)/);
      expect(mocks.renderNativeArtifact.mock.calls[0]![1]).not.toHaveProperty('candidateEngineIds');
    });

    it('blocks a personal voice that no clone engine can speak here', async () => {
      setPlatform('linux');
      mocks.profile = { ...mocks.profile, tier: 'personal' };
      const result = await generate();
      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(
        /personal voice engine 'pocket_tts' cannot run this request \(language ja\)/
      );
      expect(mocks.renderNativeArtifact).not.toHaveBeenCalled();
    });

    it('honours a purpose with engine auto', async () => {
      setPlatform('linux');
      const result = await generate({
        text: 'Good morning, here is the plan.',
        engine: { engine_id: 'auto', purpose: 'latency' },
        rendering: {
          language: 'en',
          chunking: { max_chunk_chars: 200, crossfade_ms: 0, preserve_paralinguistic_tags: true },
        },
      });
      expect(result.status).toBe('succeeded');
      expect(result.resolved_engine_id).toBe('espeak_ng');
      expect(result.engine_selection).toMatchObject({
        trigger: 'purpose',
        strategy: 'purpose',
        purpose: 'latency',
      });
    });
  });

  describe('speak_local', () => {
    const speak = (params: Record<string, unknown>) =>
      handleAction({
        action: 'speak_local',
        params,
      } as unknown as ActionInput) as Promise<VoiceResult>;

    it('is unchanged without purpose: local_say, language en', async () => {
      const result = await speak({ text: 'こんにちは' });
      expect(result.status).toBe('succeeded');
      expect(result.resolved_engine_id).toBe('local_say');
      expect(result.language).toBe('en');
      expect(result.engine_selection).toBeUndefined();
      expect(mocks.record).not.toHaveBeenCalled();
    });

    it('selects by purpose and speaks the detected language', async () => {
      setPlatform('linux');
      const result = await speak({ text: 'こんにちは', purpose: 'naturalness' });
      expect(result.status).toBe('succeeded');
      expect(result.resolved_engine_id).toBe('kokoro');
      expect(result.language).toBe('ja');
      expect(result.engine_selection).toMatchObject({ strategy: 'purpose' });
      expect(mocks.performPlayback).toHaveBeenCalledWith(
        'こんにちは',
        expect.objectContaining({ engineId: 'kokoro', language: 'ja' })
      );
    });
  });
});
