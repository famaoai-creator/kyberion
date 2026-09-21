import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  pinWrites: vi.fn(),
  safeExecResult: vi.fn(() => ({ status: 1, stdout: '', stderr: 'mlx unavailable', error: null })),
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
vi.mock('@agent/core/voice-path-policy', () => ({
  resolveVoicePath: vi.fn((value: string) => value),
}));
vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    safeMkdir: vi.fn(),
    safeWriteFile: vi.fn(),
  };
});
vi.mock('./voice-media-output-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('./voice-media-output-helpers.js')>(
    './voice-media-output-helpers.js'
  );
  return {
    ...actual,
    ensureSttReadyAudio: (audioPath: string) => ({ path: audioPath, converted: false }),
  };
});

const { registerSpeechToTextBridge, resetSpeechToTextBridge } =
  await import('@agent/core/speech-to-text-bridge');
type Bridge = import('@agent/core/speech-to-text-bridge').SpeechToTextBridge;
const { handleAction } = await import('./index.js');

const calls: string[] = [];
const bridge = (name: string, priority: number, timestamps: boolean): Bridge => ({
  name,
  priority,
  capabilities: timestamps
    ? { timestamps: true, granularity: 'segment', local_only: true }
    : { timestamps: false, granularity: 'none', local_only: true },
  transcribe: async () => {
    calls.push(name);
    return {
      text: `from ${name}`,
      backend: name,
      ...(timestamps ? { segments: [{ start_sec: 0, end_sec: 1, text: `from ${name}` }] } : {}),
    };
  },
});

const transcribe = (params: Record<string, unknown>) =>
  handleAction({
    action: 'transcribe_voice_sample',
    params: { audio_path: 'active/shared/tmp/sample.wav', write_sidecar: false, ...params },
  } as unknown as Parameters<typeof handleAction>[0]);

describe('voice-actuator purpose-driven STT selection', () => {
  beforeEach(() => {
    calls.length = 0;
    mocks.record.mockClear();
    mocks.pinWrites.mockClear();
    mocks.safeExecResult.mockClear();
    vi.stubEnv('MISSION_ID', '');
    registerSpeechToTextBridge(bridge('fluid-audio-parakeet', 100, true));
    registerSpeechToTextBridge(bridge('mlx_whisper', 90, true));
    registerSpeechToTextBridge(bridge('whisperkit-cli', 100, false));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSpeechToTextBridge();
  });

  it('keeps the priority order without a purpose', async () => {
    const result = await transcribe({});
    expect(result.backend).toBe('fluid-audio-parakeet');
    expect(calls).toEqual(['fluid-audio-parakeet']);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('orders timestamp-capable bridges by purpose', async () => {
    const result = await transcribe({ purpose: 'accuracy' });
    expect(result.backend).toBe('mlx_whisper');
    expect(calls).toEqual(['mlx_whisper']);
    expect(mocks.record.mock.calls[0]![0].metadata.excluded).toEqual([
      { id: 'whisperkit-cli', unmet: ['timestamps (segment)'] },
    ]);
    expect(mocks.pinWrites).not.toHaveBeenCalled();
  });

  it('lets text-only bridges compete when timestamps are not preferred', async () => {
    const result = await transcribe({ purpose: 'accuracy', prefer_timestamps: false });
    expect(result.backend).toBe('mlx_whisper');
    resetSpeechToTextBridge();
    registerSpeechToTextBridge(bridge('fluid-audio-parakeet', 100, true));
    registerSpeechToTextBridge(bridge('whisperkit-cli', 100, false));
    calls.length = 0;
    const text = await transcribe({ purpose: 'accuracy', prefer_timestamps: false });
    expect(text.backend).toBe('whisperkit-cli');
    expect(calls).toEqual(['whisperkit-cli']);
  });

  it('lets an explicit backend win over the purpose', async () => {
    const result = await transcribe({ purpose: 'accuracy', backend: 'fluid_audio' });
    expect(result.backend).toBe('fluid-audio-parakeet');
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('falls back to the direct mlx path when no bridge meets the requirement', async () => {
    resetSpeechToTextBridge();
    registerSpeechToTextBridge(bridge('whisperkit-cli', 100, false));
    const result = await transcribe({ purpose: 'latency' });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(
      /no usable STT backend: \[STT_SELECTION\] no provider can run this task.*mlx unavailable/
    );
    expect(mocks.safeExecResult).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('reports an unknown purpose as an error', async () => {
    const result = await transcribe({ purpose: 'cheap' });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/unknown purpose 'cheap'.*known: accuracy, latency, privacy/);
    expect(calls).toEqual([]);
  });
});
