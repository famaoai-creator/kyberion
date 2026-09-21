/**
 * Seam calibration adapter for 'voice-tts-engine': synthesise the same text
 * with every eligible TTS engine and put the artifacts side by side.
 *
 * Naturalness is a human judgement — the operator listens to each
 * `artifact_path` in the report and records a rule / measured trait. The
 * runner measures latency; audio_bytes and duration_sec are added when cheap.
 *
 * Eligibility reuses the live hard filter (listVoiceTtsEngineCandidates:
 * status, runtime adapter, platform, format, language). Each trial renders
 * through the voice-actuator's own artifact path restricted to exactly that
 * engine (no fallback chain), so a failing engine shows up as a failure
 * instead of silently becoming another engine's output. Engines that send
 * text off the machine only run when listed explicitly (--providers).
 */

import * as path from 'node:path';
import type {
  SeamCalibrationAdapter,
  SeamCalibrationTrialContext,
  SeamCalibrationTrialResult,
} from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { safeExecResult, safeExistsSync, safeStat } from '@agent/core/secure-io';
import { resolveFfprobeBin } from '@agent/core/tool-binary-resolvers';
import {
  detectTextLanguage,
  getVoiceEngineRegistry,
  isLocalVoiceEngine,
  listVoiceTtsEngineCandidates,
  normalizeLanguageTag,
  type VoiceEngineArtifactFormat,
  type VoiceEngineRecord,
} from '@agent/core/voice-engine-registry';
import { getVoiceTtsLanguageConfig } from '@agent/core/voice-tts-config';

export interface VoiceTtsEngineCalibrationInput {
  text: string;
  /** BCP-47 language of the text; detected from the script when omitted. */
  language?: string;
  /** Artifact format to render (default wav). */
  format?: VoiceEngineArtifactFormat;
}

export interface VoiceTtsRenderRequest {
  text: string;
  engine: VoiceEngineRecord;
  language: string;
  format: VoiceEngineArtifactFormat;
  outputPath: string;
  requestId: string;
}

export interface VoiceTtsEngineCalibrationDeps {
  /** Renders one artifact with exactly this engine; returns the artifact path. */
  render(request: VoiceTtsRenderRequest): Promise<string>;
  /** Audio duration in seconds, or undefined when it cannot be measured cheaply. */
  probeDurationSec(artifactPath: string): number | undefined;
  engines(): VoiceEngineRecord[];
  platform(): NodeJS.Platform;
}

async function renderWithVoiceActuator(request: VoiceTtsRenderRequest): Promise<string> {
  // Loaded lazily: the CLI registers every adapter at startup.
  const { renderNativeArtifact } =
    await import('../../../libs/actuators/voice-actuator/src/voice-runtime-helpers.js');
  const defaults = getVoiceTtsLanguageConfig(request.language);
  return renderNativeArtifact(request.text, {
    requestId: request.requestId,
    voice: defaults.voice,
    rate: defaults.rate,
    language: request.language,
    format: request.format,
    engineId: request.engine.engine_id,
    supportsFormats: request.engine.supports.artifact_formats,
    outputPath: request.outputPath,
    // Exactly this engine: no fallback to another engine's voice.
    candidateEngineIds: [request.engine.engine_id],
  });
}

function probeDurationWithFfprobe(artifactPath: string): number | undefined {
  const result = safeExecResult(
    resolveFfprobeBin(),
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      artifactPath,
    ],
    { timeoutMs: 10_000 }
  );
  if (result.error || result.status !== 0) return undefined;
  const duration = Number(String(result.stdout || '').trim());
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

const defaultDeps: VoiceTtsEngineCalibrationDeps = {
  render: renderWithVoiceActuator,
  probeDurationSec: probeDurationWithFfprobe,
  engines: () => getVoiceEngineRegistry().engines,
  platform: () => process.platform,
};

function requestLanguage(input: VoiceTtsEngineCalibrationInput): string {
  return normalizeLanguageTag(input.language) || detectTextLanguage(input.text);
}

export function createVoiceTtsEngineCalibrationAdapter(
  overrides: Partial<VoiceTtsEngineCalibrationDeps> = {}
): SeamCalibrationAdapter<VoiceTtsEngineCalibrationInput> {
  const deps: VoiceTtsEngineCalibrationDeps = { ...defaultDeps, ...overrides };
  const engineById = (id: string) => deps.engines().find((engine) => engine.engine_id === id);
  return {
    seam: 'voice-tts-engine',
    description:
      'Synthesise the same text with every eligible TTS engine; listen to the artifacts and compare latency / duration.',
    input_example: {
      // i18n-exempt: calibration sample text demonstrating ja synthesis input, not app-facing text
      text: 'こんにちは。今日の予定を確認します。',
      language: 'ja',
      format: 'wav',
    },

    async listCandidates(input: VoiceTtsEngineCalibrationInput): Promise<SeamProviderCandidate[]> {
      if (!String(input?.text ?? '').trim()) {
        throw new Error('[voice-tts-engine calibration] input.text is required');
      }
      return listVoiceTtsEngineCandidates(
        {
          language: requestLanguage(input),
          platform: deps.platform(),
          format: input.format ?? 'wav',
        },
        deps.engines()
      );
    },

    async runTrial(
      providerId: string,
      input: VoiceTtsEngineCalibrationInput,
      context: SeamCalibrationTrialContext
    ): Promise<SeamCalibrationTrialResult> {
      const engine = engineById(providerId);
      if (!engine) return { ok: false, error: `unknown voice engine '${providerId}'` };
      const format = input.format ?? 'wav';
      const outputPath = path.join(context.outDir, `${providerId}-${context.repeat}.${format}`);
      const artifactPath = await deps.render({
        text: input.text,
        engine,
        language: requestLanguage(input),
        format,
        outputPath,
        requestId: `seam-calibration-${providerId}-${context.repeat}`,
      });
      if (!safeExistsSync(artifactPath)) {
        return { ok: false, error: `${providerId} produced no artifact at ${artifactPath}` };
      }
      const metrics: Record<string, number> = { audio_bytes: safeStat(artifactPath).size };
      const duration = deps.probeDurationSec(artifactPath);
      if (duration !== undefined) metrics.duration_sec = duration;
      return { ok: true, output: { artifact_path: artifactPath }, metrics };
    },

    // naturalness needs a listener (rule / manual trait); privacy is by construction.
    trait_mappings: {
      latency: { metric: 'latency_ms', higher_is_better: false },
    },

    requiresExplicitOptIn(providerId: string): boolean {
      const engine = engineById(providerId);
      return !engine || !isLocalVoiceEngine(engine);
    },
  };
}

export const voiceTtsEngineCalibrationAdapter = createVoiceTtsEngineCalibrationAdapter();
