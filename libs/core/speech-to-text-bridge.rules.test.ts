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
  parseSpeechToTextCapabilities,
  primaryLanguageSubtag,
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  resolveSpeechToTextBridge,
  selectSpeechToTextBridges,
  shouldSelectSpeechToTextBridges,
  supportsSpeechLanguage,
  WHISPER_LANGUAGES,
} = await import('./speech-to-text-bridge.js');
type Bridge = import('./speech-to-text-bridge.js').SpeechToTextBridge;

const fake = (name: string, priority: number, capabilities: Bridge['capabilities']): Bridge => ({
  name,
  priority,
  capabilities,
  transcribe: async () => ({ text: name, backend: name }),
});

const WHISPER = [...WHISPER_LANGUAGES];
const parakeet = fake('fluid-audio-parakeet', 100, {
  timestamps: true,
  granularity: 'segment',
  local_only: true,
});
const whisperkit = fake('whisperkit-cli', 100, {
  timestamps: false,
  granularity: 'none',
  local_only: true,
  languages: WHISPER,
});
const mlx = fake('mlx_whisper', 90, {
  timestamps: true,
  granularity: 'segment',
  local_only: true,
  languages: WHISPER,
});
const englishOnly = fake('shell', 0, {
  timestamps: false,
  granularity: 'none',
  languages: ['en'],
});
const ALL = [parakeet, whisperkit, mlx, englishOnly];
const names = (bridges: Bridge[]) => bridges.map((bridge) => bridge.name);

const dir = pathResolver.sharedTmp('stt-selection-rules-test');
const rulesFile = path.join(dir, 'rules.json');

describe('speech-to-text selection: language and operator rules', () => {
  beforeEach(() => {
    record.mockClear();
    safeRmSync(dir, { recursive: true, force: true });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSpeechToTextBridge();
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('normalises language tags and treats undeclared languages as unfiltered', () => {
    expect(primaryLanguageSubtag('ja-JP')).toBe('ja');
    expect(primaryLanguageSubtag('ZH_hans')).toBe('zh');
    expect(primaryLanguageSubtag(undefined)).toBe('');
    expect(supportsSpeechLanguage(['en'], 'en-US')).toBe(true);
    expect(supportsSpeechLanguage(['en'], 'ja')).toBe(false);
    expect(supportsSpeechLanguage(undefined, 'ja')).toBe(true);
    expect(supportsSpeechLanguage(['en'], undefined)).toBe(true);
    expect(WHISPER_LANGUAGES).toContain('ja');
    expect(WHISPER_LANGUAGES).toHaveLength(100);
  });

  it('parses declared languages from shell capabilities', () => {
    expect(
      parseSpeechToTextCapabilities({
        timestamps: false,
        granularity: 'none',
        languages: ['en-US', 'ja'],
      })
    ).toEqual({ timestamps: false, granularity: 'none', languages: ['en', 'ja'] });
    expect(
      parseSpeechToTextCapabilities({ timestamps: false, granularity: 'none', languages: [1] })
    ).toEqual({ timestamps: false, granularity: 'none' });
  });

  it('makes a requested language a hard requirement and passes it as context', () => {
    const { bridges, decision } = selectSpeechToTextBridges({
      purpose: 'latency',
      requires: { language: 'ja-JP' },
      bridges: ALL,
    });
    expect(names(bridges)).not.toContain('shell');
    expect(decision.excluded).toEqual([{ id: 'shell', unmet: ['language (ja)'] }]);
    expect(decision.context).toEqual({ language: 'ja' });
    expect(decision.decision_key).toBe('latency');
  });

  it('selects without a purpose: seam default under decision key "default"', () => {
    const { bridges, decision } = selectSpeechToTextBridges({ bridges: ALL });
    expect(decision.strategy).toBe('default');
    expect(decision.decision_key).toBe('default');
    expect(bridges[0]!.name).toBe('whisperkit-cli');
  });

  it('uses the fallback purpose when the seam default cannot run the task', () => {
    const { bridges, decision } = selectSpeechToTextBridges({
      requires: { timestamps: 'segment' },
      bridges: ALL,
    });
    expect(decision.strategy).toBe('fallback');
    expect(names(bridges)).toEqual(['mlx_whisper', 'fluid-audio-parakeet']);
  });

  it('keeps the priority default when there is no purpose, no rule and no unmet need', () => {
    expect(shouldSelectSpeechToTextBridges({ bridges: ALL })).toBe(false);
    expect(resolveSpeechToTextBridge({ bridges: ALL }).name).toBe('fluid-audio-parakeet');
    expect(record).not.toHaveBeenCalled();
  });

  it('selects when the priority default cannot meet the requirements', () => {
    // The English-only bridge has the higher priority but cannot transcribe Japanese.
    const loud = fake('shell', 200, englishOnly.capabilities);
    const request = { requires: { language: 'ja' }, bridges: [loud, mlx] };
    expect(shouldSelectSpeechToTextBridges({ bridges: [loud, mlx] })).toBe(false);
    expect(shouldSelectSpeechToTextBridges(request)).toBe(true);
    expect(resolveSpeechToTextBridge(request).name).toBe('mlx_whisper');
  });

  it('applies an operator rule matched on language without a purpose', () => {
    for (const bridge of ALL) registerSpeechToTextBridge(bridge);
    setSeamSelectionRule({
      rule_id: 'ja-minutes',
      seam: 'speech-to-text-bridge',
      when: { context: { language: 'ja' } },
      prefer: ['mlx_whisper'],
      set_by: 'user:test',
    });
    expect(shouldSelectSpeechToTextBridges({ requires: { language: 'en' } })).toBe(false);
    expect(resolveSpeechToTextBridge({ requires: { language: 'en' } }).name).toBe(
      'fluid-audio-parakeet'
    );
    expect(shouldSelectSpeechToTextBridges({ requires: { language: 'ja-JP' } })).toBe(true);
    const { decision } = selectSpeechToTextBridges({ requires: { language: 'ja-JP' } });
    expect(decision.strategy).toBe('rule');
    expect(decision.rule_id).toBe('ja-minutes');
    expect(resolveSpeechToTextBridge({ context: { language: 'ja' } }).name).toBe('mlx_whisper');
  });
});
