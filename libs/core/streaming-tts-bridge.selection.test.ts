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
const { installShellStreamingTtsBridge, ShellStreamingTextToSpeechBridge } =
  await import('./shell-streaming-tts-bridge.js');
const {
  getStreamingTtsCapabilities,
  listStreamingTtsBridges,
  resetStreamingTtsBridges,
  resolveStreamingTtsBridge,
  selectStreamingTtsBridge,
  StreamingTtsSelectionError,
} = await import('./streaming-tts-bridge.js');

const dir = pathResolver.sharedTmp('streaming-tts-selection-test');
const rulesFile = path.join(dir, 'rules.json');
const ids = (bridges: Array<{ bridge_id: string }>) => bridges.map((bridge) => bridge.bridge_id);

describe('streaming-tts-bridge selection', () => {
  beforeEach(() => {
    record.mockClear();
    safeRmSync(dir, { recursive: true, force: true });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_STREAMING_TTS_BRIDGE', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetStreamingTtsBridges();
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('declares capabilities on built-in and shell bridges', () => {
    const [stub, gemini] = listStreamingTtsBridges();
    expect(getStreamingTtsCapabilities(stub!)).toEqual({
      languages: ['*'],
      local_only: true,
      synthetic: true,
    });
    expect(getStreamingTtsCapabilities(gemini!)).toEqual({
      languages: ['en', 'ja'],
      local_only: false,
    });
    const shell = new ShellStreamingTextToSpeechBridge({ bridge_id: 'shell', command: 'piper' });
    expect(shell.capabilities).toEqual({ languages: ['*'], local_only: false });
    const piper = new ShellStreamingTextToSpeechBridge({
      bridge_id: 'shell',
      command: 'piper',
      capabilities: { languages: ['en'], local_only: true },
    });
    expect(getStreamingTtsCapabilities(piper).local_only).toBe(true);
  });

  it('keeps today’s default (stub) without purpose, rules or unmet requirements', () => {
    expect(resolveStreamingTtsBridge().bridge_id).toBe('stub');
    expect(resolveStreamingTtsBridge({ requires: { language: 'ja' } }).bridge_id).toBe('stub');
    expect(record).not.toHaveBeenCalled();
  });

  it('lets the explicit bridge id / env always win', () => {
    vi.stubEnv('KYBERION_STREAMING_TTS_BRIDGE', 'gemini');
    expect(resolveStreamingTtsBridge({ purpose: 'privacy' }).bridge_id).toBe('gemini');
    expect(resolveStreamingTtsBridge({ bridgeId: 'stub', purpose: 'naturalness' }).bridge_id).toBe(
      'stub'
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('ranks by purpose among bridges that meet language and locality', () => {
    installShellStreamingTtsBridge({
      bridge_id: 'shell',
      command: 'piper',
      capabilities: { languages: ['en', 'ko'], local_only: true },
    });
    const natural = selectStreamingTtsBridge({ purpose: 'naturalness' });
    expect(ids(natural.ranked)).toEqual(['gemini', 'shell', 'stub']);
    const korean = selectStreamingTtsBridge({
      purpose: 'naturalness',
      requires: { language: 'ko' },
    });
    expect(ids(korean.ranked)).toEqual(['shell', 'stub']);
    expect(korean.decision.excluded).toEqual([{ id: 'gemini', unmet: ['language ko'] }]);
    expect(korean.decision.context).toEqual({ language: 'ko' });
    const local = selectStreamingTtsBridge({
      purpose: 'naturalness',
      requires: { localOnly: true, allowSynthetic: false },
    });
    expect(ids(local.ranked)).toEqual(['shell']);
  });

  it('falls back by purpose when the stub may not be used', () => {
    const bridge = resolveStreamingTtsBridge({ requires: { allowSynthetic: false } });
    expect(bridge.bridge_id).toBe('gemini');
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      metadata: expect.objectContaining({ strategy: 'fallback' }),
    });
  });

  it('errors clearly on unknown purposes and impossible requirements', () => {
    expect(() => selectStreamingTtsBridge({ purpose: 'loudness' })).toThrow(
      /unknown purpose 'loudness'.*known: latency, naturalness, privacy/
    );
    expect(() =>
      selectStreamingTtsBridge({ requires: { localOnly: true, allowSynthetic: false } })
    ).toThrow(StreamingTtsSelectionError);
  });

  it('applies operator rules even without a purpose', () => {
    setSeamSelectionRule({
      rule_id: 'ja-gemini',
      seam: 'streaming-tts-bridge',
      when: { context: { language: 'ja' } },
      prefer: ['gemini'],
      set_by: 'user:test',
    });
    expect(resolveStreamingTtsBridge({ requires: { language: 'ja' } }).bridge_id).toBe('gemini');
    record.mockClear();
    expect(resolveStreamingTtsBridge({ requires: { language: 'en' } }).bridge_id).toBe('stub');
    // Rules exist but none matches: no selection runs at all.
    expect(record).not.toHaveBeenCalled();
  });
});
