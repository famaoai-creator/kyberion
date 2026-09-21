import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/shell-streaming-stt-bridge', () => ({
  installShellStreamingSttBridgeFromEnv: () => ({ installed: false }),
  installManagedMlxWhisperStreamingSttBridgeIfAvailable: () => ({ installed: false }),
}));

const { registerStreamingSttBridge, resetStreamingSttBridges } =
  await import('@agent/core/streaming-stt-bridge');
const { pcmToWav } = await import('@agent/core/pcm-wav');
const { pathResolver } = await import('@agent/core/path-resolver');
const { safeMkdir, safeRmSync, safeWriteFile } = await import('@agent/core/secure-io');
const {
  decodePcmWav,
  pcmChunks,
  streamingSttBridgeCalibrationAdapter: adapter,
} = await import('./streaming-stt-bridge.js');
type AudioChunk = import('@agent/core/meeting-session-types').AudioChunk;
type StreamingBridge = import('@agent/core/streaming-stt-bridge').StreamingSpeechToTextBridge;

const dir = pathResolver.sharedTmp('streaming-stt-calibration-test');
const wavPath = path.join(dir, 'sample.wav');

function echoBridge(id: string, text: string, seen: number[]): StreamingBridge {
  return {
    bridge_id: id,
    async *transcribeStream(audio: AsyncIterable<AudioChunk>) {
      let chunks = 0;
      for await (const _ of audio) chunks += 1;
      seen.push(chunks);
      yield { utterance_id: 'u1', is_final: false, text: 'partial', emitted_at: '' };
      yield { utterance_id: 'u1', is_final: true, text, emitted_at: '' };
    },
  };
}

describe('decodePcmWav / pcmChunks', () => {
  it('decodes a 16 kHz mono s16le WAV and splits it into 100 ms chunks', () => {
    const decoded = decodePcmWav(pcmToWav(Buffer.alloc(16_000 * 2 * 0.25), 16_000));
    expect(decoded.format).toEqual({ encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 });
    const chunks = [...pcmChunks(decoded, 100)];
    expect(chunks.map((c) => c.payload.length)).toEqual([3200, 3200, 1600]);
    expect(chunks.map((c) => c.ts_ms)).toEqual([0, 100, 200]);
  });

  it('rejects files AudioChunk cannot carry', () => {
    expect(() => decodePcmWav(Buffer.from('not a wav file'))).toThrow(/RIFF\/WAVE/);
    expect(() => decodePcmWav(pcmToWav(Buffer.alloc(100), 22_050))).toThrow(/sample rate/);
  });
});

describe('streaming-stt-bridge calibration adapter', () => {
  beforeEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
    safeMkdir(dir, { recursive: true });
    safeWriteFile(wavPath, pcmToWav(Buffer.alloc(16_000 * 2 * 0.3), 16_000));
  });
  afterEach(() => {
    resetStreamingSttBridges();
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('lists the stub as ineligible and applies the language requirement', async () => {
    const seen: number[] = [];
    registerStreamingSttBridge('managed_mlx_whisper', () => echoBridge('m', 'x', seen), {
      local_only: true,
      languages: ['ja'],
    });
    registerStreamingSttBridge('shell', () => echoBridge('s', 'x', seen));
    const candidates = await adapter.listCandidates({ audio_path: wavPath, language: 'en' });
    expect(candidates).toEqual([
      { id: 'stub', eligible: false, unmet: ['synthetic output not allowed'] },
      { id: 'managed_mlx_whisper', eligible: false, unmet: ['language (en)'] },
      { id: 'shell', eligible: true, unmet: [] },
    ]);
    expect(adapter.requiresExplicitOptIn?.('shell')).toBe(true);
    expect(adapter.requiresExplicitOptIn?.('managed_mlx_whisper')).toBe(false);
  });

  it('streams the file and scores only final text', async () => {
    const seen: number[] = [];
    registerStreamingSttBridge('mlx_whisper', () => echoBridge('mlx_whisper', '三点です', seen));
    const result = await adapter.runTrial(
      'mlx_whisper',
      { audio_path: wavPath, reference_text: '三点です。', chunk_ms: 100 },
      { outDir: dir, repeat: 0 }
    );
    expect(seen).toEqual([3]);
    expect(result).toEqual({
      ok: true,
      output: { text: '三点です' },
      metrics: { final_chunks: 1, char_error_rate: 0 },
    });
  });

  it('fails a trial that produces no final transcript', async () => {
    registerStreamingSttBridge('mlx_whisper', () => echoBridge('mlx_whisper', ' ', []));
    const result = await adapter.runTrial(
      'mlx_whisper',
      { audio_path: wavPath },
      { outDir: dir, repeat: 0 }
    );
    expect(result).toEqual({ ok: false, error: 'bridge produced no final transcript' });
  });
});
