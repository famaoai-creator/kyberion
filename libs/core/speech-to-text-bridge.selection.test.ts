import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
const pinWrites = vi.fn();
vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));
vi.mock('./provider-pins-store.js', () => ({
  loadSeamProviderPin: () => null,
  pinSeamProviderDecision: (...args: unknown[]) => pinWrites(...args),
}));

const {
  getSpeechToTextBridge,
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  selectSpeechToTextBridges,
  SpeechToTextSelectionError,
  stubSpeechToTextBridge,
} = await import('./speech-to-text-bridge.js');
const { createAppleSpeechToTextBridge } = await import('./apple-intelligence-bridge.js');
type Bridge = import('./speech-to-text-bridge.js').SpeechToTextBridge;

const fake = (name: string, priority: number, capabilities: Bridge['capabilities']): Bridge => ({
  name,
  priority,
  capabilities,
  transcribe: async () => ({ text: name, backend: name }),
});

const SEGMENTS = { timestamps: true, granularity: 'segment', local_only: true } as const;
const TEXT_LOCAL = { timestamps: false, granularity: 'none', local_only: true } as const;
const parakeet = fake('fluid-audio-parakeet', 100, SEGMENTS);
const whisperkit = fake('whisperkit-cli', 100, TEXT_LOCAL);
const mlx = fake('mlx_whisper', 90, SEGMENTS);
const shell = fake('shell', 0, { timestamps: true, granularity: 'word' });
const ALL = [parakeet, whisperkit, mlx, shell];
const names = (bridges: Bridge[]) => bridges.map((bridge) => bridge.name);

describe('purpose-driven speech-to-text bridge selection', () => {
  beforeEach(() => {
    record.mockClear();
    pinWrites.mockClear();
    vi.stubEnv('MISSION_ID', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSpeechToTextBridge();
  });

  it('orders eligible bridges by purpose and records the decision without pinning', () => {
    const accuracy = selectSpeechToTextBridges({ purpose: 'accuracy', bridges: ALL });
    expect(names(accuracy.bridges)).toEqual([
      'mlx_whisper',
      'whisperkit-cli',
      'fluid-audio-parakeet',
      'shell',
    ]);
    expect(accuracy.decision.strategy).toBe('purpose');
    const latency = selectSpeechToTextBridges({ purpose: 'latency', bridges: ALL });
    expect(latency.bridges[0]!.name).toBe('fluid-audio-parakeet');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'speech-to-text-bridge/fluid-audio-parakeet' })
    );
    expect(pinWrites).not.toHaveBeenCalled();
  });

  it('keeps hard requirements as eligibility, not ranking', () => {
    const { bridges, decision } = selectSpeechToTextBridges({
      purpose: 'accuracy',
      requires: { timestamps: 'segment', localOnly: true },
      bridges: ALL,
    });
    expect(names(bridges)).toEqual(['mlx_whisper', 'fluid-audio-parakeet']);
    expect(decision.excluded).toEqual([
      { id: 'whisperkit-cli', unmet: ['timestamps (segment)'] },
      { id: 'shell', unmet: ['local_only'] },
    ]);
    const word = selectSpeechToTextBridges({
      purpose: 'latency',
      requires: { timestamps: 'word' },
      bridges: ALL,
    });
    expect(names(word.bridges)).toEqual(['shell']);
  });

  it('treats the synthetic stub as ineligible unless allowed', () => {
    expect(() =>
      selectSpeechToTextBridges({ purpose: 'accuracy', bridges: [stubSpeechToTextBridge] })
    ).toThrow(SpeechToTextSelectionError);
    expect(() =>
      selectSpeechToTextBridges({ purpose: 'accuracy', bridges: [stubSpeechToTextBridge] })
    ).toThrow(/stub: synthetic output not allowed/);
    const allowed = selectSpeechToTextBridges({
      purpose: 'accuracy',
      requires: { allowSynthetic: true },
      bridges: [whisperkit, stubSpeechToTextBridge],
    });
    expect(names(allowed.bridges)).toEqual(['whisperkit-cli', 'stub']);
  });

  it('rejects unknown purposes naming the known ones', () => {
    expect(() => selectSpeechToTextBridges({ purpose: 'cheap', bridges: ALL })).toThrow(
      /unknown purpose 'cheap'.*known: accuracy, latency, privacy/
    );
  });

  it('defaults to the registered bridges and leaves the no-purpose seam choice unchanged', () => {
    for (const bridge of ALL) registerSpeechToTextBridge(bridge);
    // Priority select: 100-tie broken by id, independent of any purpose.
    expect(getSpeechToTextBridge().name).toBe('fluid-audio-parakeet');
    const privacy = selectSpeechToTextBridges({ purpose: 'privacy' });
    expect(privacy.bridges[0]!.name).toBe('mlx_whisper');
    expect(names(privacy.bridges)).toContain('shell');
    expect(getSpeechToTextBridge().name).toBe('fluid-audio-parakeet');
  });

  it('declares the on-device Apple Speech bridge as local_only', () => {
    const apple = createAppleSpeechToTextBridge();
    expect(apple.capabilities?.local_only).toBe(true);
    const { bridges } = selectSpeechToTextBridges({
      purpose: 'privacy',
      requires: { localOnly: true },
      bridges: [apple, shell],
    });
    expect(names(bridges)).toEqual(['apple-speech']);
  });
});
