/**
 * Apple Speech (SFSpeechRecognizer) file transcription, as a SpeechToTextBridge.
 *
 * Why this exists alongside the Apple Intelligence bridge: that one drives the
 * SpeechAnalyzer/SpeechTranscriber stack, which is macOS 26+. On macOS 15 the
 * whole bridge probes unavailable, and in-room minutes fall back to the stub —
 * i.e. a meeting gets recorded and nothing is transcribed. SFSpeechRecognizer
 * has been available since macOS 10.15, so this covers the gap with the OS's
 * own recognizer and no install, no model download, and no network.
 *
 * `satellites/voice-hub/native-stt.swift --transcribe-file` is the same script
 * the live listen path uses; the URL request is a separate mode inside it.
 * On-device recognition is enforced there, so audio never leaves the machine.
 */
import * as path from 'node:path';

import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeWriteFile } from './secure-io.js';
import {
  getSpeechToTextBridges,
  registerSpeechToTextBridge,
  type SpeechToTextBridge,
  type TranscribeInput,
  type TranscribeResult,
} from './speech-to-text-bridge.js';

export const APPLE_SPEECH_FILE_BRIDGE_NAME = 'apple-speech-file';

const SCRIPT_PATH = 'satellites/voice-hub/native-stt.swift';
/** Recognition of a long segment is slow the first time a locale warms up. */
const DEFAULT_TIMEOUT_SEC = 180;

interface NativeSttPayload {
  ok?: boolean;
  text?: string;
  error?: string;
  locale?: string;
}

/** BCP-47 in, BCP-47 out; bare language tags get a sensible region. */
export function resolveAppleSpeechFileLocale(language?: string): string {
  const raw = String(language || '').trim();
  if (!raw) return 'ja-JP';
  if (raw.includes('-')) return raw;
  const map: Record<string, string> = { ja: 'ja-JP', en: 'en-US', zh: 'zh-CN', ko: 'ko-KR' };
  return map[raw.toLowerCase()] || raw;
}

/** macOS frameworks print loader noise to stdout; take the last JSON line. */
function parseLastJsonLine(stdout: string): NativeSttPayload | null {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as NativeSttPayload;
    } catch {
      continue;
    }
  }
  return null;
}

export function isAppleSpeechFileTranscriptionSupported(): boolean {
  if (process.platform !== 'darwin') return false;
  return safeExistsSync(pathResolver.resolve(SCRIPT_PATH));
}

export function transcribeAudioFileWithAppleSpeech(
  audioPath: string,
  options: { locale?: string; timeoutSec?: number } = {}
): { text: string; locale: string } {
  const audioAbs = pathResolver.rootResolve(audioPath);
  if (!safeExistsSync(audioAbs)) {
    throw new Error(`[stt-bridge:apple-speech-file] audio file not found: ${audioPath}`);
  }
  const locale = resolveAppleSpeechFileLocale(options.locale);
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const result = safeExecResult(
    'swift',
    [
      pathResolver.resolve(SCRIPT_PATH),
      '--transcribe-file',
      audioAbs,
      '--locale',
      locale,
      '--timeout',
      String(timeoutSec),
    ],
    { cwd: pathResolver.rootDir(), timeoutMs: timeoutSec * 1000 + 15_000, maxOutputMB: 4 }
  );
  const payload = parseLastJsonLine(result.stdout || '');
  if (!payload) {
    throw new Error(
      `[stt-bridge:apple-speech-file] no result from recognizer: ${
        result.stderr?.slice(0, 200) || result.error?.message || `exit ${result.status}`
      }`
    );
  }
  if (!payload.ok) {
    throw new Error(`[stt-bridge:apple-speech-file] ${payload.error || 'transcription failed'}`);
  }
  // An empty transcript is a valid outcome: the segment held no speech.
  return { text: String(payload.text ?? ''), locale: payload.locale || locale };
}

export function createAppleSpeechFileToTextBridge(): SpeechToTextBridge {
  return {
    name: APPLE_SPEECH_FILE_BRIDGE_NAME,
    // Lower than the managed runtimes: those give word timings, this does not.
    priority: 50,
    capabilities: { timestamps: false, granularity: 'none', local_only: true },
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const { text, locale } = transcribeAudioFileWithAppleSpeech(input.audioPath, {
        locale: input.language,
      });
      const audioAbs = pathResolver.rootResolve(input.audioPath);
      const parsed = path.parse(audioAbs);
      const outputPath = input.outputPath
        ? pathResolver.rootResolve(input.outputPath)
        : path.join(parsed.dir, `${parsed.name}.transcript.txt`);
      safeWriteFile(outputPath, `${text}\n`, { encoding: 'utf8', mkdir: true });
      return {
        text,
        language: locale,
        written_to: outputPath,
        backend: APPLE_SPEECH_FILE_BRIDGE_NAME,
        capabilities: { timestamps: false, granularity: 'none' },
      };
    },
  };
}

/**
 * Register the bridge when the platform supports it. Call AFTER the explicit
 * and managed backends: an operator-configured command always wins over an
 * implicit OS capability.
 */
export function installAppleSpeechFileToTextBridgeIfAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (getSpeechToTextBridges().some((bridge) => bridge.name === APPLE_SPEECH_FILE_BRIDGE_NAME)) {
    return true;
  }
  if (env.KYBERION_STT_COMMAND?.trim() || env.KYBERION_FLUID_AUDIO_STT_COMMAND?.trim()) {
    return false;
  }
  if (!isAppleSpeechFileTranscriptionSupported()) return false;
  registerSpeechToTextBridge(createAppleSpeechFileToTextBridge());
  logger.info('[stt-bridge] installed AppleSpeechFileToTextBridge (SFSpeechRecognizer, on-device)');
  return true;
}
