import {
  getVoiceProfileRecord,
  getVoiceTtsLanguageConfig,
  pathResolver,
  resolveVoiceEngineForPlatform,
  safeExec,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  type AudioChunk,
  type AudioFormat,
  type TtsLoopbackVerificationRequest,
  type TtsSource,
} from '@agent/core';
import { isRecord } from '@agent/core/foundation';
import * as path from 'node:path';
import { renderNativeArtifact } from './voice-runtime-helpers.js';

export function createDeterministicLoopbackTts(): TtsSource {
  const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 };
  return {
    bridge_id: 'deterministic-loopback-tts',
    async *synthesize(_text: string) {
      const payload = new Uint8Array((format.sample_rate_hz / 10) * 2);
      const view = new DataView(payload.buffer);
      for (let index = 0; index < payload.byteLength; index += 2) {
        view.setInt16(index, Math.round(Math.sin(index / 7) * 2_000), true);
      }
      yield { format, payload, ts_ms: 0 };
    },
  };
}

export function createDeterministicLoopbackStt(expectedText: string): {
  readonly bridge_id: string;
  transcribeStream(audio: AsyncIterable<AudioChunk>): AsyncIterable<{
    utterance_id: string;
    is_final: boolean;
    text: string;
    confidence: number;
    emitted_at: string;
  }>;
} {
  return {
    bridge_id: 'deterministic-loopback-stt',
    async *transcribeStream(audio) {
      let chunks = 0;
      for await (const _chunk of audio) chunks += 1;
      if (chunks > 0) {
        yield {
          utterance_id: 'deterministic-loopback-utterance',
          is_final: true,
          text: expectedText,
          confidence: 1,
          emitted_at: new Date().toISOString(),
        };
      }
    },
  };
}

export function buildLoopbackRequest(
  params: Record<string, unknown>,
  requestId: string,
  text: string,
  language: string,
  profileId: string,
  bus: 'blackhole' | 'stub',
  dryRun: boolean
): TtsLoopbackVerificationRequest {
  const route = recordParam(params, 'audio_route');
  const format = recordParam(params, 'format');
  const timing = recordParam(params, 'timing');
  const quality = recordParam(params, 'quality');
  const persistence = recordParam(params, 'persistence');
  return {
    request_id: requestId,
    ...(stringParam(params, 'mission_id') ? { mission_id: stringParam(params, 'mission_id') } : {}),
    ...(stringParam(params, 'tenant_slug')
      ? { tenant_slug: stringParam(params, 'tenant_slug') }
      : {}),
    text,
    ...(stringParam(params, 'expected_text')
      ? { expected_text: stringParam(params, 'expected_text') }
      : {}),
    language,
    voice_profile_id: profileId,
    audio_route: {
      bus,
      ...(stringParam(route, 'input_device_uid')
        ? { input_device_uid: stringParam(route, 'input_device_uid') }
        : {}),
      ...(stringParam(route, 'output_device_uid')
        ? { output_device_uid: stringParam(route, 'output_device_uid') }
        : {}),
      ...(stringParam(route, 'expected_device_label')
        ? { expected_device_label: stringParam(route, 'expected_device_label') }
        : {}),
    },
    ...(format
      ? {
          format: {
            encoding: 'pcm_s16le',
            sample_rate_hz: numberParam(format, 'sample_rate_hz', 16_000) as
              16_000 | 24_000 | 48_000,
            channels: numberParam(format, 'channels', 1) as 1 | 2,
          },
        }
      : {}),
    ...(timing ? { timing: numericRecord(timing) } : {}),
    ...(quality ? { quality: numericRecord(quality) } : {}),
    ...(persistence
      ? {
          persistence: {
            retain_audio: booleanParam(persistence, 'retain_audio'),
            retain_transcript: booleanParam(persistence, 'retain_transcript'),
            ...(stringParam(persistence, 'output_dir')
              ? { output_dir: stringParam(persistence, 'output_dir') }
              : {}),
          },
        }
      : {}),
    dry_run: dryRun,
  };
}

export function createNativeArtifactTtsSource(options: {
  requestId: string;
  language: string;
  profileId: string;
}): TtsSource {
  return {
    bridge_id: 'voice-engine-artifact-to-pcm',
    async *synthesize(text, voiceProfileId) {
      const profile = getVoiceProfileRecord(voiceProfileId || options.profileId);
      const defaults = getVoiceTtsLanguageConfig(options.language);
      const engine = resolveVoiceEngineForPlatform(profile.default_engine_id);
      const artifactFormats = engine.supports.artifact_formats;
      const artifactFormat =
        process.platform === 'darwin' &&
        engine.engine_id === 'local_say' &&
        artifactFormats.includes('aiff')
          ? 'aiff'
          : artifactFormats.includes('wav')
            ? 'wav'
            : (artifactFormats[0] ?? 'wav');
      const artifact = await renderNativeArtifact(text, {
        requestId: options.requestId,
        voice: defaults.voice,
        rate: defaults.rate,
        language: options.language,
        format: artifactFormat,
        engineId: engine.engine_id,
        supportsFormats: engine.supports.artifact_formats,
        profile,
      });
      const rawPath = pathResolver.sharedTmp(`voice-loopback/${options.requestId}.pcm`);
      safeMkdir(path.dirname(rawPath), { recursive: true });
      try {
        safeExec('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          artifact,
          '-f',
          's16le',
          '-ac',
          '1',
          '-ar',
          '16000',
          rawPath,
        ]);
        const raw = Buffer.from(safeReadFile(rawPath, { encoding: null }) as Buffer);
        const chunkBytes = 640;
        for (let offset = 0; offset < raw.byteLength; offset += chunkBytes) {
          const payload = new Uint8Array(
            raw.subarray(offset, Math.min(raw.byteLength, offset + chunkBytes))
          );
          if (payload.byteLength % 2 !== 0) continue;
          yield {
            format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
            payload,
            ts_ms: offset / 32,
          };
        }
      } finally {
        safeRmSync(rawPath, { force: true });
        safeRmSync(artifact, { force: true });
      }
    },
  };
}

export function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function booleanParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

export function numberParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  return typeof params[key] === 'number' && Number.isFinite(params[key])
    ? (params[key] as number)
    : fallback;
}

export function recordParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  return isRecord(params[key]) ? params[key] : {};
}

export function numericRecord(params: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value)
    )
  ) as Record<string, number>;
}

export { isRecord };

export function extractActionParams(input: {
  action?: unknown;
  params?: unknown;
  [key: string]: unknown;
}): Record<string, unknown> {
  if (isRecord(input.params)) return input.params;
  const { action: _action, ...params } = input;
  return params;
}
