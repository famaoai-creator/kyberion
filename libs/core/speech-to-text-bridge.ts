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

export interface TranscribeResult {
  text: string;
  language?: string;
  written_to?: string;
  backend: string;
  /** True when the result came from a fallback (e.g. sidecar) rather than real STT. */
  synthetic?: boolean;
}

export interface SpeechToTextBridge {
  name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

let registered: SpeechToTextBridge | null = null;

export function registerSpeechToTextBridge(bridge: SpeechToTextBridge): void {
  registered = bridge;
}

export function getSpeechToTextBridge(): SpeechToTextBridge {
  return registered ?? stubSpeechToTextBridge;
}

export function resetSpeechToTextBridge(): void {
  registered = null;
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
  async transcribe(input) {
    const audioAbs = rootResolve(input.audioPath);
    const sidecar = deriveSidecar(audioAbs);
    if (safeExistsSync(sidecar)) {
      const text = safeReadFile(sidecar, { encoding: 'utf8' }) as string;
      logger.warn(
        `[stt-bridge:stub] using pre-baked sidecar ${sidecar} — register a real SpeechToTextBridge to decode audio.`,
      );
      return {
        text,
        language: input.language,
        written_to: sidecar,
        backend: 'stub-sidecar',
        synthetic: true,
      };
    }
    throw new Error(
      `[stt-bridge:stub] no transcript backend registered and no sidecar at ${sidecar}. ` +
        `Register a ShellSpeechToTextBridge or drop a pre-made transcript next to the audio.`,
    );
  },
};

export interface ShellSpeechToTextBridgeOptions {
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
}

export class ShellSpeechToTextBridge implements SpeechToTextBridge {
  readonly name = 'shell';
  constructor(private readonly options: ShellSpeechToTextBridgeOptions) {}

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
    const text = stdout.trim();
    const outputPath = input.outputPath ? rootResolve(input.outputPath) : defaultTranscriptPath(audioAbs);
    safeWriteFile(outputPath, `${text}\n`, { encoding: 'utf8', mkdir: true });
    return {
      text,
      language: input.language,
      written_to: outputPath,
      backend: 'shell',
    };
  }
}

/**
 * Bootstrap helper: wire up a ShellSpeechToTextBridge when
 * `KYBERION_STT_COMMAND` is set in the environment. Returns true when
 * a real backend was installed; false when the stub remains.
 */
export function installShellSpeechToTextBridgeIfAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = env.KYBERION_STT_COMMAND?.trim();
  if (!command) return false;
  registerSpeechToTextBridge(
    new ShellSpeechToTextBridge({
      command,
      ...(env.KYBERION_STT_TIMEOUT_MS
        ? { timeoutMs: parseInt(env.KYBERION_STT_TIMEOUT_MS, 10) }
        : {}),
    }),
  );
  logger.success(
    `[stt-bridge] installed ShellSpeechToTextBridge from KYBERION_STT_COMMAND`,
  );
  return true;
}
