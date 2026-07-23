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
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { rootResolve } from './path-resolver.js';

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

const registered = new Map<string, SpeechToTextBridge>();

export function registerSpeechToTextBridge(bridge: SpeechToTextBridge): void {
  const name = String(bridge.name || '').trim();
  if (!name) throw new Error('SpeechToTextBridge.name is required');
  registered.set(name, bridge);
}

export function getSpeechToTextBridge(): SpeechToTextBridge {
  return getSpeechToTextBridges()[0] || stubSpeechToTextBridge;
}

export function getSpeechToTextBridges(): SpeechToTextBridge[] {
  return registered.size > 0 ? [...registered.values()] : [stubSpeechToTextBridge];
}

export function resetSpeechToTextBridge(): void {
  registered.clear();
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

function parseStructuredOutput(stdout: string): Partial<TranscribeResult> {
  try {
    return JSON.parse(stdout) as Partial<TranscribeResult>;
  } catch {
    // Swift/CoreML loaders and model runtimes may print informational lines;
    // accept the final JSON object while keeping malformed output fatal.
    for (const line of stdout.split(/\r?\n/u).reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        return JSON.parse(trimmed) as Partial<TranscribeResult>;
      } catch {
        continue;
      }
    }
    throw new Error('structured output was not valid JSON');
  }
}

function deriveSidecar(audioAbs: string): string {
  return `${audioAbs}.transcript.txt`;
}

function defaultTranscriptPath(audioAbs: string): string {
  const parsed = path.parse(audioAbs);
  return path.join(parsed.dir, `${parsed.name}.transcript.txt`);
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
    const audioAbs = rootResolve(input.audioPath);
    const sidecar = deriveSidecar(audioAbs);
    if (safeExistsSync(sidecar)) {
      const text = safeReadFile(sidecar, { encoding: 'utf8' }) as string;
      logger.warn(
        `[stt-bridge:stub] using pre-baked sidecar ${sidecar} — register a real SpeechToTextBridge to decode audio.`
      );
      return {
        text,
        language: input.language,
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
    const audioAbs = rootResolve(input.audioPath);
    if (!safeExistsSync(audioAbs)) {
      throw new Error(`[stt-bridge:shell] audio file not found: ${input.audioPath}`);
    }
    const cmd = this.options.command
      .replace(/\{\{audio\}\}/gu, audioAbs)
      .replace(/\{\{language\}\}/gu, input.language ?? '');
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
    const outputPath = input.outputPath
      ? rootResolve(input.outputPath)
      : defaultTranscriptPath(audioAbs);
    safeWriteFile(outputPath, `${text}\n`, { encoding: 'utf8', mkdir: true });
    return {
      text,
      language: input.language,
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
      capabilities = JSON.parse(env.KYBERION_STT_CAPABILITIES) as SpeechToTextCapabilities;
    } catch (error: any) {
      logger.warn(`[stt-bridge] ignored invalid KYBERION_STT_CAPABILITIES: ${error.message}`);
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
