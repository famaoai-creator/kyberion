import {
  pcmToWav,
  pathResolver,
  registerStreamingSttBridge,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  safeExecResult,
  type AudioChunk,
  type StreamingSpeechToTextBridge,
} from '@agent/core';
import * as path from 'node:path';
import { resolvePythonBin } from './voice-runtime-helpers.js';

export interface VoiceLoopbackSttAdapterOptions {
  request_id: string;
  language: string;
}

/**
 * Installs only the requested backend adapter. The loopback verifier remains
 * backend-agnostic and resolves the resulting bridge through the core
 * streaming-STT registry.
 */
export function registerVoiceLoopbackSttAdapter(
  bridgeId: string | undefined,
  options: VoiceLoopbackSttAdapterOptions
): void {
  if (bridgeId === 'mlx_whisper') {
    registerStreamingSttBridge(bridgeId, () => createMlxWhisperBridge(options));
  }
}

function createMlxWhisperBridge(
  options: VoiceLoopbackSttAdapterOptions
): StreamingSpeechToTextBridge {
  return {
    bridge_id: 'mlx_whisper',
    async *transcribeStream(audio) {
      const chunks: Buffer[] = [];
      let hasAudio = false;
      for await (const chunk of audio) {
        hasAudio = true;
        assertLoopbackFormat(chunk);
        chunks.push(Buffer.from(chunk.payload));
      }
      if (!hasAudio || chunks.length === 0) return;

      const audioPath = pathResolver.sharedTmp(`voice-loopback/${options.request_id}.stt.wav`);
      safeMkdir(path.dirname(audioPath), { recursive: true });
      try {
        safeWriteFile(audioPath, pcmToWav(Buffer.concat(chunks), 16_000));
        const script = pathResolver.rootResolve(
          'libs/actuators/voice-actuator/scripts/mlx_audio_stt_bridge.py'
        );
        const result = safeExecResult(resolvePythonBin('mlx_whisper'), [script], {
          input: JSON.stringify({
            action: 'transcribe',
            params: { audio_path: audioPath, language: options.language },
          }),
          env: { KYBERION_PROJECT_ROOT: pathResolver.rootResolve('.') },
          timeoutMs: 120_000,
          maxOutputMB: 2,
        });
        if (result.error || result.status !== 0) {
          throw new Error(
            `voice STT backend failed: ${result.stderr || result.error?.message || 'unknown error'}`
          );
        }
        const response: unknown = JSON.parse(result.stdout);
        if (!isRecord(response) || response.status !== 'success') {
          throw new Error(
            `voice STT backend returned an error: ${
              isRecord(response) && typeof response.error === 'string'
                ? response.error
                : 'invalid response'
            }`
          );
        }
        const text = typeof response.text === 'string' ? response.text.trim() : '';
        if (text) {
          yield {
            utterance_id: `${options.request_id}-final`,
            is_final: true,
            text,
            emitted_at: new Date().toISOString(),
          };
        }
      } finally {
        safeRmSync(audioPath, { force: true });
      }
    },
  };
}

function assertLoopbackFormat(chunk: AudioChunk): void {
  if (
    chunk.format.encoding !== 'pcm_s16le' ||
    chunk.format.sample_rate_hz !== 16_000 ||
    chunk.format.channels !== 1
  ) {
    throw new Error('voice STT backend requires 16kHz mono pcm_s16le');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
