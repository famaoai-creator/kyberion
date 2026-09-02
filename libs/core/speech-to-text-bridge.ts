/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
/**
 * Speech-to-Text Bridge — contract for transcribing audio files into text
 * so downstream pipelines (requirements-elicitation etc.) can consume
 * recordings directly rather than waiting for a manual transcript.
 *
 * The stub resolves by looking for a `<audio>.transcript.txt` sidecar next
 * to the audio file — this lets operators drop a pre-made transcript when
 * no real backend is registered, keeping offline / CI flows working.
 *
 * Real backends:
 *   - ShellSpeechToTextBridge — runs a user-configured CLI (whisper.cpp,
 *     mlx-audio, openai-whisper, etc.). Registered via bootstrap when
 *     KYBERION_STT_COMMAND is set.
 *   - Future: WhisperKit / MLX server adapter (voice-stt.ts already
 *     resolves server config).
 */

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from './core.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExecResult,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { rootResolve } from './path-resolver.js';
import { resolveLocale } from './locale.js';
import { resolveManagedToolPythonBin } from './tool-runtime-registry.js';
import { coreSeamCatalog, createSeam } from './seam.js';

export interface TranscribeInput {
  audioPath: string;
  /** BCP-47 tag. Leave empty for auto-detect. */
  language?: string;
  /** Optional output path for the transcript text. Defaults to <audio>.transcript.txt. */
  outputPath?: string;
}

export interface SpeechToTextCapabilities {
  /** Whether the backend returns time ranges for transcript segments. */
  timestamps: boolean;
  /** The finest timestamp granularity available from the backend. */
  granularity: 'none' | 'segment' | 'word';
  /** Whether audio remains on the local machine during transcription. */
  local_only?: boolean;
  /** Whether the backend exposes a confidence score for its output. */
  confidence?: boolean;
}

export interface TranscriptSegment {
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  written_to?: string;
  backend: string;
  capabilities?: SpeechToTextCapabilities;
  segments?: TranscriptSegment[];
  /** True when the result came from a fallback (e.g. sidecar) rather than real STT. */
  synthetic?: boolean;
}

export interface SpeechToTextBridge {
  name: string;
  capabilities?: SpeechToTextCapabilities;
  /** Stable tie-breaker; higher values are preferred when capabilities match. */
  priority?: number;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

export const NO_TIMESTAMP_STT_CAPABILITIES: SpeechToTextCapabilities = {
  timestamps: false,
  granularity: 'none',
};

export function getSpeechToTextCapabilities(
  bridge: Pick<SpeechToTextBridge, 'capabilities'>
): SpeechToTextCapabilities {
  return bridge.capabilities ?? NO_TIMESTAMP_STT_CAPABILITIES;
}

const speechToTextSeam = createSeam<SpeechToTextBridge>({
  key: 'speech-to-text-bridge',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  select: (providers) =>
    [...providers].sort(
      (left, right) =>
        (right.implementation.priority ?? 0) - (left.implementation.priority ?? 0) ||
        left.id.localeCompare(right.id)
    )[0]?.implementation,
});
const registeredDisposers = new Map<string, () => void>();

export function registerSpeechToTextBridge(bridge: SpeechToTextBridge): () => void {
  const name = String(bridge.name || '').trim();
  if (!name) throw new Error('SpeechToTextBridge.name is required');
  const disposer = speechToTextSeam.register(name, bridge, {
    provenance: 'builtin',
    source: 'speech-to-text-bridge',
  });
  registeredDisposers.set(name, disposer);
  return disposer;
}

export function getSpeechToTextBridge(): SpeechToTextBridge {
  return speechToTextSeam.getOptional() || stubSpeechToTextBridge;
}

export function getSpeechToTextBridges(): SpeechToTextBridge[] {
  const bridges = speechToTextSeam.list().map((provider) => provider.implementation);
  return bridges.length > 0 ? bridges : [stubSpeechToTextBridge];
}

export function resetSpeechToTextBridge(): void {
  for (const dispose of registeredDisposers.values()) dispose();
  registeredDisposers.clear();
}

export function normalizeSpeechToTextResult(
  bridge: Pick<SpeechToTextBridge, 'name' | 'capabilities'>,
  result: TranscribeResult
): TranscribeResult {
  const validSegments = (result.segments || []).filter((segment) => {
    return (
      Number.isFinite(segment.start_sec) &&
      Number.isFinite(segment.end_sec) &&
      segment.start_sec >= 0 &&
      segment.end_sec > segment.start_sec &&
      Boolean(String(segment.text || '').trim())
    );
  });
  const declared = result.capabilities || getSpeechToTextCapabilities(bridge);
  const hasTimestamps = declared.timestamps && validSegments.length > 0;
  return {
    ...result,
    backend: result.backend || bridge.name,
    capabilities: {
      ...declared,
      timestamps: hasTimestamps,
      granularity: hasTimestamps ? declared.granularity : 'none',
    },
    ...(result.segments ? { segments: validSegments } : {}),
  };
}

export function parseSpeechToTextCapabilities(
  value: unknown
): SpeechToTextCapabilities | undefined {
  if (!isRecord(value) || typeof value.timestamps !== 'boolean') return undefined;
  if (
    value.granularity !== 'none' &&
    value.granularity !== 'segment' &&
    value.granularity !== 'word'
  ) {
    return undefined;
  }
  return {
    timestamps: value.timestamps,
    granularity: value.granularity,
    ...(typeof value.local_only === 'boolean' ? { local_only: value.local_only } : {}),
    ...(typeof value.confidence === 'boolean' ? { confidence: value.confidence } : {}),
  };
}

function parseStructuredSegments(value: unknown): TranscriptSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.start_sec !== 'number' ||
      !Number.isFinite(entry.start_sec) ||
      typeof entry.end_sec !== 'number' ||
      !Number.isFinite(entry.end_sec) ||
      typeof entry.text !== 'string'
    ) {
      return [];
    }
    return [{ start_sec: entry.start_sec, end_sec: entry.end_sec, text: entry.text }];
  });
}

function projectStructuredOutput(record: Record<string, unknown>): Partial<TranscribeResult> {
  const capabilities = parseSpeechToTextCapabilities(record.capabilities);
  const segments = parseStructuredSegments(record.segments);
  return {
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(typeof record.language === 'string' ? { language: record.language } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(segments ? { segments } : {}),
  };
}

function parseStructuredOutput(stdout: string): Partial<TranscribeResult> {
  const parseRecord = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = parseSafeJsonInput(candidate, 'speech-to-text response');
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const parsed = parseRecord(stdout);
  if (parsed) {
    return projectStructuredOutput(parsed);
  }

  try {
    // Swift/CoreML loaders and model runtimes may print informational lines;
    // accept the final JSON object while keeping malformed output fatal.
    for (const line of stdout.split(/\r?\n/u).reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      const lineRecord = parseRecord(trimmed);
      if (lineRecord) {
        return projectStructuredOutput(lineRecord);
      }
    }
  } catch {
    // Keep the stable error below even when a future candidate parser throws.
  }
  throw new Error('structured output was not valid JSON');
}

function deriveSidecar(audioAbs: string): string {
  return `${audioAbs}.transcript.txt`;
}

function defaultTranscriptPath(audioAbs: string): string {
  const parsed = path.parse(audioAbs);
  return path.join(parsed.dir, `${parsed.name}.transcript.txt`);
}

function resolveAudioPath(audioPath: string): string {
  return assertSafeRepositoryPath(rootResolve(audioPath));
}

function resolveTranscriptPath(outputPath: string | undefined, audioAbs: string): string {
  const candidate = outputPath ? rootResolve(outputPath) : defaultTranscriptPath(audioAbs);
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

/**
 * Stub bridge — accepts a sidecar `<audio>.transcript.txt` next to the
 * audio file as a pre-baked transcript. Never tries to actually decode
 * audio; fails loudly when no sidecar is available.
 */
export const stubSpeechToTextBridge: SpeechToTextBridge = {
  name: 'stub',
  capabilities: NO_TIMESTAMP_STT_CAPABILITIES,
  async transcribe(input) {
    const audioAbs = resolveAudioPath(input.audioPath);
    const sidecar = assertSafeRepositoryPath(deriveSidecar(audioAbs), {
      allowMissingLeaf: true,
    });
    if (safeExistsSync(sidecar)) {
      const text = safeReadFile(sidecar, { encoding: 'utf8' }) as string;
      logger.warn(
        `[stt-bridge:stub] using pre-baked sidecar ${sidecar} — register a real SpeechToTextBridge to decode audio.`
      );
      return {
        text,
        // I18N-06: an unset transcribe language falls back to the resolved
        // locale (identity/env/OS), not a hardcoded default — same pattern
        // as `python-voice-bridge.ts`'s TTS language (I18N-01).
        language: input.language || resolveLocale(),
        written_to: sidecar,
        backend: 'stub-sidecar',
        capabilities: NO_TIMESTAMP_STT_CAPABILITIES,
        synthetic: true,
      };
    }
    throw new Error(
      `[stt-bridge:stub] no transcript backend registered and no sidecar at ${sidecar}. ` +
        `Register a ShellSpeechToTextBridge or drop a pre-made transcript next to the audio.`
    );
  },
};

export interface ShellSpeechToTextBridgeOptions {
  /** Stable bridge name used in registry diagnostics. Defaults to `shell`. */
  name?: string;
  /**
   * Shell command template. `{{audio}}` is replaced with the absolute audio
   * path, `{{language}}` with the BCP-47 code (empty string when unset).
   * Stdout is captured as the transcript.
   *
   * Example (whisper.cpp):
   *   'whisper -m models/ggml-base.bin -f "{{audio}}" -l "{{language}}" --output-txt -'
   * Example (openai CLI):
   *   'openai audio transcribe --file "{{audio}}" --response-format text'
   */
  command: string;
  /** Shell binary. Defaults to $SHELL or /bin/sh. */
  shell?: string;
  /** Timeout ms. Defaults to 5 minutes (audio files can be long). */
  timeoutMs?: number;
  /** Parse stdout as structured JSON with text/capabilities/segments. */
  structuredOutput?: boolean;
  capabilities?: SpeechToTextCapabilities;
  priority?: number;
}

export class ShellSpeechToTextBridge implements SpeechToTextBridge {
  readonly name: string;
  readonly capabilities: SpeechToTextCapabilities;
  readonly priority: number;
  constructor(private readonly options: ShellSpeechToTextBridgeOptions) {
    this.name = options.name?.trim() || 'shell';
    this.capabilities = options.capabilities || NO_TIMESTAMP_STT_CAPABILITIES;
    this.priority = Number(options.priority || 0);
  }

  private getCapabilities(): SpeechToTextCapabilities {
    return this.capabilities;
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const audioAbs = resolveAudioPath(input.audioPath);
    if (!safeExistsSync(audioAbs)) {
      throw new Error(`[stt-bridge:shell] audio file not found: ${input.audioPath}`);
    }
    // I18N-06: an unset transcribe language falls back to the resolved
    // locale (identity/env/OS) instead of an empty string, matching the
    // stub bridge above and `python-voice-bridge.ts`'s TTS language (I18N-01).
    const resolvedLanguage = input.language ?? resolveLocale();
    const cmd = this.options.command
      .replace(/\{\{audio\}\}/gu, audioAbs)
      .replace(/\{\{language\}\}/gu, resolvedLanguage);
    const shell = this.options.shell ?? process.env.SHELL ?? '/bin/sh';
    const stdout = execFileSync(shell, ['-c', cmd], {
      encoding: 'utf8',
      timeout: this.options.timeoutMs ?? 5 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    let structured: Partial<TranscribeResult> = {};
    if (this.options.structuredOutput) {
      try {
        structured = parseStructuredOutput(stdout);
      } catch (error: any) {
        throw new Error(
          `[stt-bridge:shell] structured output was not valid JSON: ${error.message}`
        );
      }
    }
    const text = String(structured.text || stdout).trim();
    const outputPath = resolveTranscriptPath(input.outputPath, audioAbs);
    safeWriteFile(outputPath, `${text}\n`, { encoding: 'utf8', mkdir: true });
    return {
      text,
      language: resolvedLanguage,
      written_to: outputPath,
      backend: 'shell',
      capabilities: structured.capabilities || this.getCapabilities(),
      ...(structured.segments ? { segments: structured.segments } : {}),
    };
  }
}

/**
 * Install a FluidAudio/Parakeet batch bridge when the caller supplies a local
 * command. The command receives {{audio}} and {{language}} substitutions and
 * must print {"text":"..."}; this keeps the Swift package optional while
 * making the Kyberion boundary concrete and testable.
 */
export function installFluidAudioSpeechToTextBridgeIfAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.KYBERION_STT_COMMAND?.trim()) return false;
  const command = env.KYBERION_FLUID_AUDIO_STT_COMMAND?.trim();
  if (!command) return false;
  registerSpeechToTextBridge(
    new ShellSpeechToTextBridge({
      name: 'fluid-audio-parakeet',
      command,
      structuredOutput: true,
      priority: 100,
      capabilities: { timestamps: true, granularity: 'segment', local_only: true },
      ...(env.KYBERION_FLUID_AUDIO_STT_TIMEOUT_MS
        ? { timeoutMs: parseInt(env.KYBERION_FLUID_AUDIO_STT_TIMEOUT_MS, 10) }
        : {}),
    })
  );
  logger.success('[stt-bridge] installed FluidAudio Parakeet bridge');
  return true;
}

/**
 * Bootstrap helper: wire up a ShellSpeechToTextBridge when
 * `KYBERION_STT_COMMAND` is set in the environment. Returns true when
 * a real backend was installed; false when the stub remains.
 */
export function installShellSpeechToTextBridgeIfAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const command = env.KYBERION_STT_COMMAND?.trim();
  if (!command) return false;
  let capabilities: SpeechToTextCapabilities | undefined;
  if (env.KYBERION_STT_CAPABILITIES?.trim()) {
    try {
      const parsed: unknown = parseSafeJsonInput(
        env.KYBERION_STT_CAPABILITIES,
        'speech-to-text capabilities'
      );
      capabilities = parseSpeechToTextCapabilities(parsed);
      if (!capabilities) {
        logger.warn('[stt-bridge] ignored invalid KYBERION_STT_CAPABILITIES shape');
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`[stt-bridge] ignored invalid KYBERION_STT_CAPABILITIES: ${detail}`);
    }
  }
  registerSpeechToTextBridge(
    new ShellSpeechToTextBridge({
      command,
      ...(env.KYBERION_STT_OUTPUT_FORMAT === 'json' ? { structuredOutput: true } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(env.KYBERION_STT_PRIORITY ? { priority: parseInt(env.KYBERION_STT_PRIORITY, 10) } : {}),
      ...(env.KYBERION_STT_TIMEOUT_MS
        ? { timeoutMs: parseInt(env.KYBERION_STT_TIMEOUT_MS, 10) }
        : {}),
    })
  );
  logger.success(`[stt-bridge] installed ShellSpeechToTextBridge from KYBERION_STT_COMMAND`);
  return true;
}

/**
 * Use the governed MLX Whisper runtime when no explicit STT adapter was set.
 * This keeps the model process behind the SpeechToTextBridge boundary while
 * allowing the realtime CLI to work immediately after `kyberion voice setup --apply`.
 */
export function installManagedMlxWhisperSpeechToTextBridgeIfAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.KYBERION_STT_COMMAND?.trim() || env.KYBERION_FLUID_AUDIO_STT_COMMAND?.trim()) {
    return false;
  }
  const pythonBin = resolveManagedToolPythonBin('mlx_whisper');
  const bridgeScript = assertSafeRepositoryPath(
    rootResolve('libs/actuators/voice-actuator/scripts/mlx_audio_stt_bridge.py')
  );
  if (!pythonBin || !safeExistsSync(bridgeScript)) return false;

  registerSpeechToTextBridge({
    name: 'mlx_whisper',
    priority: 90,
    capabilities: { timestamps: true, granularity: 'segment', local_only: true },
    async transcribe(input) {
      const audioAbs = resolveAudioPath(input.audioPath);
      if (!safeExistsSync(audioAbs)) {
        throw new Error(`[stt-bridge:mlx_whisper] audio file not found: ${input.audioPath}`);
      }
      const result = safeExecResult(pythonBin, [bridgeScript], {
        input: JSON.stringify({
          action: 'transcribe',
          params: { audio_path: audioAbs, ...(input.language ? { language: input.language } : {}) },
        }),
        env: { KYBERION_PROJECT_ROOT: assertSafeRepositoryPath(rootResolve('.')) },
        timeoutMs: 120_000,
        maxOutputMB: 2,
      });
      if (result.error || result.status !== 0) {
        throw new Error(
          `[stt-bridge:mlx_whisper] backend failed: ${result.stderr || result.error?.message || 'unknown error'}`
        );
      }
      const response = parseStructuredOutput(result.stdout);
      const text = String(response.text || '').trim();
      if (!text) throw new Error('[stt-bridge:mlx_whisper] backend returned empty text');
      const outputPath = resolveTranscriptPath(input.outputPath, audioAbs);
      safeWriteFile(outputPath, `${text}\n`, { encoding: 'utf8', mkdir: true });
      return {
        text,
        language: String(response.language || input.language || resolveLocale()),
        written_to: outputPath,
        backend: 'mlx_whisper',
        capabilities: response.capabilities || {
          timestamps: true,
          granularity: 'segment',
          local_only: true,
        },
        ...(Array.isArray(response.segments)
          ? { segments: response.segments as TranscriptSegment[] }
          : {}),
      };
    },
  });
  logger.success('[stt-bridge] installed managed mlx_whisper SpeechToTextBridge');
  return true;
}
