import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/speech-to-text-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/speech-to-text-bridge')>();
  return {
    ...actual,
    installShellSpeechToTextBridgeIfAvailable: () => false,
    installFluidAudioSpeechToTextBridgeIfAvailable: () => false,
    installWhisperKitSpeechToTextBridgeIfAvailable: () => false,
    installManagedMlxWhisperSpeechToTextBridgeIfAvailable: () => false,
  };
});
vi.mock('@agent/core/apple-intelligence-bridge', () => ({
  installAppleSpeechToTextBridgeIfAvailable: async () => false,
}));
vi.mock('@agent/core/apple-speech-file-stt-bridge', () => ({
  installAppleSpeechFileToTextBridgeIfAvailable: () => false,
}));

const { registerSpeechToTextBridge, resetSpeechToTextBridge } =
  await import('@agent/core/speech-to-text-bridge');
const { pathResolver } = await import('@agent/core/path-resolver');
const { safeRmSync } = await import('@agent/core/secure-io');
const { registerSeamCalibrationAdapter, runSeamCalibration } =
  await import('@agent/core/seam-calibration');
const {
  normalizeTranscriptForCer,
  speechToTextBridgeCalibrationAdapter: adapter,
  transcriptCharErrorRate,
} = await import('./speech-to-text-bridge.js');
type Bridge = import('@agent/core/speech-to-text-bridge').SpeechToTextBridge;

const outRoot = pathResolver.sharedTmp('stt-calibration-adapter-test');

function bridge(name: string, text: string, capabilities: Bridge['capabilities']): Bridge {
  return {
    name,
    capabilities,
    transcribe: vi.fn(async () => ({ text, backend: name })),
  };
}

describe('transcriptCharErrorRate', () => {
  it('is 0 for identical transcripts and ignores spacing, punctuation and width', () => {
    expect(transcriptCharErrorRate('本日の議題は三点です。', '本日の 議題は 三点です')).toBe(0);
    expect(transcriptCharErrorRate('Hello, World!', 'hello world')).toBe(0);
    expect(transcriptCharErrorRate('ＡＢＣ', 'abc')).toBe(0);
    expect(normalizeTranscriptForCer('a b')).toEqual(['a', 'b']);
  });

  it('counts substitutions, insertions and deletions per reference character', () => {
    expect(transcriptCharErrorRate('本日の議題は二点です', '本日の議題は三点です')).toBeCloseTo(
      0.1
    );
    expect(transcriptCharErrorRate('hello', 'hell')).toBeCloseTo(0.25);
    expect(transcriptCharErrorRate('hel', 'hell')).toBeCloseTo(0.25);
  });

  it('handles empty inputs and caps at 1', () => {
    expect(transcriptCharErrorRate('', '')).toBe(0);
    expect(transcriptCharErrorRate('', 'abc')).toBe(1);
    expect(transcriptCharErrorRate('abc', '')).toBe(1);
    expect(transcriptCharErrorRate('xxxxxxxx', 'ab')).toBe(1);
  });

  it('compares code points, not UTF-16 units', () => {
    expect(transcriptCharErrorRate('𠮷野家', '吉野家')).toBeCloseTo(1 / 3);
  });
});

describe('speech-to-text-bridge calibration adapter', () => {
  beforeEach(() => safeRmSync(outRoot, { recursive: true, force: true }));
  afterEach(() => {
    resetSpeechToTextBridge();
    safeRmSync(outRoot, { recursive: true, force: true });
  });

  it('lists installed bridges with the live eligibility check (language, synthetic)', async () => {
    registerSpeechToTextBridge(
      bridge('mlx_whisper', 'x', {
        timestamps: true,
        granularity: 'segment',
        local_only: true,
        languages: ['en', 'ja'],
      })
    );
    registerSpeechToTextBridge(
      bridge('shell', 'x', { timestamps: false, granularity: 'none', languages: ['en'] })
    );
    const candidates = await adapter.listCandidates({ audio_path: 'a.wav', language: 'ja' });
    expect(candidates).toEqual([
      { id: 'mlx_whisper', eligible: true, unmet: [] },
      { id: 'shell', eligible: false, unmet: ['language (ja)'] },
    ]);
  });

  it('requires explicit opt-in for bridges that do not declare local_only', async () => {
    registerSpeechToTextBridge(
      bridge('whisperkit-cli', 'x', { timestamps: false, granularity: 'none', local_only: true })
    );
    registerSpeechToTextBridge(bridge('shell', 'x', { timestamps: false, granularity: 'none' }));
    expect(adapter.requiresExplicitOptIn?.('whisperkit-cli')).toBe(false);
    expect(adapter.requiresExplicitOptIn?.('shell')).toBe(true);
    expect(adapter.requiresExplicitOptIn?.('unknown')).toBe(true);
  });

  it('runs trials and suggests accuracy from char_error_rate', async () => {
    const good = bridge('mlx_whisper', '本日の議題は三点です', {
      timestamps: true,
      granularity: 'segment',
      local_only: true,
    });
    const weak = bridge('whisperkit-cli', '本日の議題は二点です', {
      timestamps: false,
      granularity: 'none',
      local_only: true,
    });
    const cloud = bridge('shell', '本日の議題は三点です', {
      timestamps: false,
      granularity: 'none',
    });
    for (const b of [good, weak, cloud]) registerSpeechToTextBridge(b);
    const dispose = registerSeamCalibrationAdapter(adapter);
    try {
      const report = await runSeamCalibration({
        seam: 'speech-to-text-bridge',
        input: { audio_path: 'a.wav', reference_text: '本日の議題は三点です', language: 'ja' },
        outRoot,
        runId: 'stt-test',
      });
      const byId = Object.fromEntries(report.providers.map((p) => [p.provider_id, p]));
      expect(byId.mlx_whisper!.metrics_mean.char_error_rate).toBe(0);
      expect(byId['whisperkit-cli']!.metrics_mean.char_error_rate).toBeCloseTo(0.1);
      expect(byId.shell!.skipped_reason).toMatch(/list it in --providers/);
      expect(cloud.transcribe).not.toHaveBeenCalled();
      expect(report.suggested_traits.accuracy).toEqual({ mlx_whisper: 1, 'whisperkit-cli': 0 });
      expect(good.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({ audioPath: 'a.wav', language: 'ja' })
      );
    } finally {
      dispose();
    }
  });

  it('fails a trial on synthetic output instead of scoring it', async () => {
    const sidecar: Bridge = {
      name: 'mlx_whisper',
      capabilities: { timestamps: false, granularity: 'none', local_only: true },
      transcribe: async () => ({ text: 'x', backend: 'stub-sidecar', synthetic: true }),
    };
    registerSpeechToTextBridge(sidecar);
    const result = await adapter.runTrial(
      'mlx_whisper',
      { audio_path: 'a.wav' },
      { outDir: outRoot, repeat: 0 }
    );
    expect(result).toEqual({ ok: false, error: 'synthetic transcript (sidecar), not STT' });
  });
});
