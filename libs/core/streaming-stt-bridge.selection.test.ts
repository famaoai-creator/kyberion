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
  getStreamingSttBridgeCapabilities,
  listStreamingSttBridges,
  registerStreamingSttBridge,
  resetStreamingSttBridges,
  selectStreamingSttBridge,
  StubStreamingSpeechToTextBridge,
} = await import('./streaming-stt-bridge.js');
const { installShellStreamingSttBridge } = await import('./shell-streaming-stt-bridge.js');

const dir = pathResolver.sharedTmp('streaming-stt-selection-test');
const rulesFile = path.join(dir, 'rules.json');

function fakeBridge(id: string, capabilities?: Parameters<typeof registerStreamingSttBridge>[2]) {
  registerStreamingSttBridge(
    id,
    () => Object.assign(new StubStreamingSpeechToTextBridge(), { bridge_id: id }),
    capabilities
  );
}

describe('streaming STT seam selection', () => {
  beforeEach(() => {
    record.mockClear();
    safeRmSync(dir, { recursive: true, force: true });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_STREAMING_STT_BRIDGE', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetStreamingSttBridges();
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('declares capabilities: stub synthetic, loopback whisper local, shell undeclared', () => {
    installShellStreamingSttBridge({ bridge_id: 'shell', command: 'true' });
    installShellStreamingSttBridge({
      bridge_id: 'managed_mlx_whisper',
      command: 'true',
      capabilities: { local_only: true, languages: ['ja'] },
    });
    expect(getStreamingSttBridgeCapabilities('stub')).toEqual({
      synthetic: true,
      local_only: true,
    });
    expect(getStreamingSttBridgeCapabilities('shell')).toEqual({});
    expect(getStreamingSttBridgeCapabilities('managed_mlx_whisper')).toEqual({
      local_only: true,
      languages: ['ja'],
    });
    expect(getStreamingSttBridgeCapabilities('faster_whisper').local_only).toBe(true);
    expect(listStreamingSttBridges()).toEqual(['stub', 'managed_mlx_whisper', 'shell']);
  });

  it('keeps the stub default when synthetic output is allowed and nothing asks to select', () => {
    fakeBridge('shell');
    const selection = selectStreamingSttBridge({ requires: { allowSynthetic: true } });
    expect(selection).toMatchObject({ bridge_id: 'stub', source: 'default' });
    expect(selection.decision).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('ranks real bridges with the fallback purpose when the stub cannot run the task', () => {
    fakeBridge('shell');
    fakeBridge('managed_mlx_whisper', { local_only: true, languages: ['en', 'ja'] });
    const selection = selectStreamingSttBridge({ requires: { language: 'ja-JP' } });
    expect(selection.bridge_id).toBe('managed_mlx_whisper');
    expect(selection.bridge.bridge_id).toBe('managed_mlx_whisper');
    expect(selection.source).toBe('selected');
    expect(selection.decision?.strategy).toBe('fallback');
    expect(selection.decision?.context).toEqual({ language: 'ja' });
    expect(selection.decision?.excluded).toEqual([
      { id: 'stub', unmet: ['synthetic output not allowed'] },
    ]);
  });

  it('applies hard requirements: local_only excludes undeclared shell commands', () => {
    fakeBridge('shell');
    fakeBridge('mlx_whisper');
    const selection = selectStreamingSttBridge({
      purpose: 'latency',
      requires: { localOnly: true },
    });
    expect(selection.bridge_id).toBe('mlx_whisper');
    expect(selection.decision?.excluded).toContainEqual({ id: 'shell', unmet: ['local_only'] });
  });

  it('returns the stub with the unresolved decision when no real bridge is eligible', () => {
    const selection = selectStreamingSttBridge({ requires: { allowSynthetic: false } });
    expect(selection.bridge_id).toBe('stub');
    expect(selection.decision?.strategy).toBe('unresolved');
    expect(selection.decision?.rationale).toMatch(/stub: synthetic output not allowed/);
  });

  it('lets explicit ids and KYBERION_STREAMING_STT_BRIDGE win', () => {
    fakeBridge('shell');
    fakeBridge('mlx_whisper');
    expect(selectStreamingSttBridge({ bridgeId: 'shell', purpose: 'privacy' })).toMatchObject({
      bridge_id: 'shell',
      source: 'explicit',
    });
    vi.stubEnv('KYBERION_STREAMING_STT_BRIDGE', 'stub');
    expect(selectStreamingSttBridge({ purpose: 'accuracy' })).toMatchObject({
      bridge_id: 'stub',
      source: 'explicit',
    });
  });

  it('rejects unknown purposes and applies operator rules', () => {
    fakeBridge('shell');
    fakeBridge('mlx_whisper');
    expect(() => selectStreamingSttBridge({ purpose: 'cheap' })).toThrow(
      /unknown purpose 'cheap'.*known: accuracy, latency, privacy/
    );
    setSeamSelectionRule({
      rule_id: 'ja-stream',
      seam: 'streaming-stt-bridge',
      when: { context: { language: 'ja' } },
      prefer: ['shell'],
      set_by: 'user:test',
    });
    const ja = selectStreamingSttBridge({ requires: { language: 'ja' } });
    expect(ja.bridge_id).toBe('shell');
    expect(ja.decision?.strategy).toBe('rule');
    // Rules exist but none matches and synthetic output is allowed: no selection at all.
    record.mockClear();
    const synthetic = selectStreamingSttBridge({ requires: { allowSynthetic: true } });
    expect(synthetic).toMatchObject({ bridge_id: 'stub', source: 'default' });
    expect(synthetic.decision).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
});
