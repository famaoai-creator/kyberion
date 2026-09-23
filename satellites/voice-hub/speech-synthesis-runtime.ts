/**
 * PA-09 return-audio mode — the engine side of `POST /api/speech/synthesize`
 * (contract + handler: `speech-synthesis.ts`). Kept out of `server.ts` so the
 * daemon stays under the max-file-lines boundary.
 *
 * Runs the selected TTS engine (with its registry fallback, same selection as
 * host playback) to a WAV artifact under `active/shared/tmp/` WITHOUT playing
 * it; the handler reads, returns and always deletes the artifact.
 *   - python_bridge engines: the server's managed bridge (already writes WAV).
 *   - native_tts: `say -o … --file-format=WAVE` / `espeak -w …`; other
 *     platforms → `SpeechSynthesisUnsupportedError` (HTTP 501, clients fall back).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  assertSafeRepositoryPath,
  buildSafeExecEnv,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeRmSync,
} from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { estimateSpeechDurationMs } from '@agent/core/presence-surface';
import { getVoiceTtsLanguageConfig } from '@agent/core/voice-tts-config';
import {
  getVoiceEngineRegistry,
  resolveVoiceEngineForPlatform,
  type VoiceEngineRecord,
} from '@agent/core/voice-engine-registry';
import { resolveVoiceTtsAdapter } from '@agent/core/voice-provider-adapters';
import {
  NATIVE_TTS_FILE_TIMEOUT_MS,
  SPEECH_SYNTHESIZE_MAX_AUDIO_BYTES,
  SpeechSynthesisUnsupportedError,
  buildNativeTtsFileCommand,
  createSpeechSynthesizeHandler,
  estimateSpokenDurationMs,
  parseWavInfo,
  type SpeechSynthesisLanguage,
} from './speech-synthesis.js';

const MAX_AUDIO_MB = SPEECH_SYNTHESIZE_MAX_AUDIO_BYTES / (1024 * 1024);

function readArtifactBytes(artifactPath: string): Buffer {
  return safeReadFile(artifactPath, { encoding: null, maxSizeMB: MAX_AUDIO_MB }) as Buffer;
}

function removeArtifact(artifactPath: string): void {
  if (safeExistsSync(artifactPath)) safeRmSync(artifactPath, { force: true });
}

/** Playback length from a WAV artifact's header, or undefined. */
export function readWavDurationMs(artifactPath: string): number | undefined {
  try {
    return parseWavInfo(readArtifactBytes(artifactPath))?.durationMs;
  } catch {
    return undefined;
  }
}

/** Text-based bound on host speech length (CJK-aware). */
export function estimateHostSpeechMs(text: string): number {
  return estimateSpokenDurationMs(text, estimateSpeechDurationMs(text));
}

/** `say` / `espeak` to a WAV file under active/shared/tmp/ (no playback). */
export async function runNativeTtsToFile(
  engineId: string,
  text: string,
  options: { voice?: string; rate?: number }
): Promise<string> {
  const outputPath = pathResolver.sharedTmp(`voice-synth-${randomUUID()}.wav`);
  const command = buildNativeTtsFileCommand(process.platform, text, options, outputPath);
  if (!command) {
    throw new SpeechSynthesisUnsupportedError(
      `native_tts_file_output_unsupported_${process.platform}`
    );
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.cmd, command.args, {
        cwd: pathResolver.rootDir(),
        env: buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), NATIVE_TTS_FILE_TIMEOUT_MS);
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk).slice(0, 20_000);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new Error(stderr.trim() || `native_tts_file_failed_${code || signal || 'unknown'}`));
      });
    });
    const safePath = assertSafeRepositoryPath(outputPath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
      throw new Error(`${engineId} synthesis artifact is missing`);
    }
    return safePath;
  } catch (error) {
    removeArtifact(outputPath);
    throw error;
  }
}

export interface VoiceHubSpeechSynthesisDeps {
  /** The user-selected engine (same selection as host playback). */
  resolvePreferredEngine(): VoiceEngineRecord;
  loadVoiceProfile(): unknown;
  /** The server's managed python bridge; returns a WAV artifact path. */
  runPythonBridge(
    engine: VoiceEngineRecord,
    text: string,
    language: string,
    profile: unknown,
    voice: string,
    rate: number
  ): Promise<string>;
  detectLanguage(text: string): SpeechSynthesisLanguage;
  normalizeText(text: string, language: SpeechSynthesisLanguage): string;
  onSynthesized?(result: { text: string; durationMs: number; engineId: string }): void;
  warn(message: string): void;
}

/** Wire the synthesize handler to the real engines. */
export function createVoiceHubSpeechSynthesizeHandler(deps: VoiceHubSpeechSynthesisDeps) {
  const synthesizeWith = async (
    engine: VoiceEngineRecord,
    text: string,
    language: string,
    profile: unknown
  ): Promise<string> => {
    const adapter = resolveVoiceTtsAdapter(engine);
    const languageProfile = getVoiceTtsLanguageConfig(language);
    if (adapter.adapter_id === 'python_bridge') {
      return deps.runPythonBridge(
        engine,
        text,
        language,
        profile,
        languageProfile.voice,
        languageProfile.rate
      );
    }
    if (adapter.adapter_id === 'native_tts') {
      return runNativeTtsToFile(engine.engine_id, text, {
        voice: languageProfile.voice,
        rate: languageProfile.rate,
      });
    }
    throw new SpeechSynthesisUnsupportedError(
      `tts_adapter_${adapter.adapter_id}_cannot_return_audio`
    );
  };

  return createSpeechSynthesizeHandler({
    synthesize: async (text, language) => {
      const engine = deps.resolvePreferredEngine();
      const profile = deps.loadVoiceProfile();
      try {
        return {
          artifactPath: await synthesizeWith(engine, text, language, profile),
          engineId: engine.engine_id,
        };
      } catch (error) {
        const fallbackId = engine.fallback_engine_id || getVoiceEngineRegistry().default_engine_id;
        const fallback = resolveVoiceEngineForPlatform(fallbackId);
        if (fallback.engine_id === engine.engine_id) throw error;
        deps.warn(
          `[voice-hub] ${engine.engine_id} synthesis failed; falling back to ${fallback.engine_id}: ${error instanceof Error ? error.message : String(error)}`
        );
        return {
          artifactPath: await synthesizeWith(fallback, text, language, profile),
          engineId: fallback.engine_id,
        };
      }
    },
    readArtifact: readArtifactBytes,
    removeArtifact,
    detectLanguage: deps.detectLanguage,
    normalizeText: deps.normalizeText,
    onSynthesized: deps.onSynthesized,
    onError: (error) =>
      deps.warn(
        `[voice-hub] speech synthesis failed: ${error instanceof Error ? error.message : String(error)}`
      ),
  });
}
