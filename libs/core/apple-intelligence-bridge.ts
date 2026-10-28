import * as path from 'node:path';
import { logger } from './core.js';
import { normalizeAppleVisionResult, type AppleVisionResult } from './apple-vision-result.js';
export {
  normalizeAppleVisionResult,
  type AppleVisionResult,
  type AppleVisionLine,
} from './apple-vision-result.js';
import { resolveLocale } from './locale.js';
import { localeToBcp47 } from './locale-normalize.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeStat,
  safeRealpath,
  validateFileSize,
} from './secure-io.js';
import { spawnManagedProcess } from './managed-process.js';
import {
  getSpeechToTextBridges,
  registerSpeechToTextBridge,
  type SpeechToTextBridge,
  type SpeechToTextCapabilities,
  type TranscribeInput,
  type TranscribeResult,
} from './voice/speech-to-text-bridge.js';
import { rootResolve } from './path-resolver.js';
import { isAppleSilicon } from './platform.js';
import { safeWriteFile } from './secure-io.js';

/**
 * Apple Intelligence bridge — on-device Foundation Models (macOS 26+) as a
 * LOCAL ASSIST layer, per the provider-native capability bridge architecture
 * (knowledge/product/architecture/apple-intelligence-native-capability-bridge.md).
 *
 * Scope by design: light, latency-sensitive, privacy-preserving helpers —
 * summaries, reply formatting, local intent pre-classification, short UI
 * guide text. It is NOT a ReasoningBackend: the ~3B on-device model must
 * never be selected for mission planning, structured extraction, or other
 * heavy reasoning, so it does not enter that failover chain at all.
 *
 * Every entry point degrades to `null` when the device, OS, toolchain, or
 * user opt-in is missing — callers always keep their existing path.
 *
 * The Swift side lives in tools/apple-intelligence-bridge/afm.swift and is
 * compiled on demand (single `swiftc` invocation, cached binary).
 */

const BRIDGE_SOURCE = 'tools/apple-intelligence-bridge/afm.swift';
const BINARY_CACHE_DIR = 'active/shared/runtime/apple-intelligence';
const SWIFT_MODULE_CACHE_DIR = `${BINARY_CACHE_DIR}/module-cache`;

export interface AppleIntelligenceAvailability {
  available: boolean;
  reason?: string;
}

export function normalizeAppleIntelligenceAvailability(
  value: unknown
): AppleIntelligenceAvailability | undefined {
  if (!isRecord(value) || typeof value.available !== 'boolean') return undefined;
  if (value.reason !== undefined && typeof value.reason !== 'string') return undefined;
  return {
    available: value.available,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

interface AfmRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable for tests; production uses the managed-process runner. */
export type AfmRunner = (
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs: number }
) => Promise<AfmRunResult>;

function defaultRunner(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs: number }
): Promise<AfmRunResult> {
  return new Promise((resolvePromise) => {
    const { child } = spawnManagedProcess({
      resourceId: `apple-fm:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'service',
      ownerId: 'apple-intelligence-bridge',
      ownerType: 'core',
      command,
      args,
      shutdownPolicy: 'idle',
      idleTimeoutMs: options.timeoutMs + 5_000,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolvePromise({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      settle(false);
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      settle(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle(code === 0);
    });
    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

let injectedRunner: AfmRunner | null = null;
const runner: AfmRunner = async (command, args, options) => {
  try {
    return await (injectedRunner ?? defaultRunner)(command, args, options);
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};
export function setAfmRunnerForTests(customRunner: AfmRunner | null): void {
  injectedRunner = customRunner;
}

function bridgeDisabledByEnv(): boolean {
  const flag = String(getRegisteredEnvText('KYBERION_APPLE_FM') || '').toLowerCase();
  return flag === '0' || flag === 'false' || flag === 'off';
}

function afmBinaryPath(): string {
  return pathResolver.rootResolve(path.join(BINARY_CACHE_DIR, 'afm'));
}

function bridgeSourcePath(): string {
  return pathResolver.rootResolve(BRIDGE_SOURCE);
}

function binaryIsFresh(): boolean {
  try {
    const binary = afmBinaryPath();
    if (!safeExistsSync(binary)) return false;
    const source = bridgeSourcePath();
    if (!safeExistsSync(source)) return true; // deployed binary without source
    return safeStat(binary).mtimeMs >= safeStat(source).mtimeMs;
  } catch {
    return false;
  }
}

async function ensureAfmBinary(options: { deadlineAtMs?: number } = {}): Promise<string | null> {
  if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) return null;
  const binary = afmBinaryPath();
  if (binaryIsFresh()) return binary;
  const source = bridgeSourcePath();
  if (!safeExistsSync(source)) return null;
  try {
    safeMkdir(path.dirname(binary), { recursive: true });
    safeMkdir(pathResolver.rootResolve(SWIFT_MODULE_CACHE_DIR), { recursive: true });
  } catch (err) {
    logger.warn(
      `[apple-fm] cannot prepare binary cache dir: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  const compileTimeoutMs =
    options.deadlineAtMs === undefined
      ? 120_000
      : Math.min(120_000, options.deadlineAtMs - Date.now());
  if (compileTimeoutMs <= 0) return null;
  const compile = await runner(
    'swiftc',
    [
      '-O',
      // Deployment target 26.0: forces every macOS-27-only API behind an
      // `#available(macOS 27.0, *)` guard at COMPILE time, so a 27.2 build
      // can never silently ship a 27-only call that crashes 26 hosts.
      '-target',
      'arm64-apple-macos26.0',
      '-module-cache-path',
      pathResolver.rootResolve(SWIFT_MODULE_CACHE_DIR),
      source,
      '-o',
      binary,
    ],
    { timeoutMs: compileTimeoutMs }
  );
  if (!compile.ok) {
    logger.warn(`[apple-fm] swiftc compile failed: ${compile.stderr.slice(0, 300)}`);
    return null;
  }
  return binary;
}

let cachedAvailability: { checkedAt: number; value: AppleIntelligenceAvailability } | null = null;
const AVAILABILITY_TTL_MS = 10 * 60 * 1000;

const APPLE_SPEECH_LOCALE_DEFAULTS: Record<string, string> = {
  de: 'de-DE',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
};

function resolveAppleSpeechLocale(language?: string): string {
  const normalized = language?.trim() || localeToBcp47(resolveLocale());
  return APPLE_SPEECH_LOCALE_DEFAULTS[normalized.toLowerCase()] || normalized;
}

export function _resetAppleIntelligenceAvailabilityCacheForTests(): void {
  cachedAvailability = null;
}

/**
 * Platform gate + live probe (`afm availability`), cached for 10 minutes.
 * Safe to call from any platform.
 */
export async function probeAppleIntelligence(): Promise<AppleIntelligenceAvailability> {
  if (bridgeDisabledByEnv()) return { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  if (cachedAvailability && Date.now() - cachedAvailability.checkedAt < AVAILABILITY_TTL_MS) {
    return cachedAvailability.value;
  }
  const value = await probeUncached();
  cachedAvailability = { checkedAt: Date.now(), value };
  return value;
}

async function probeUncached(): Promise<AppleIntelligenceAvailability> {
  if (bridgeDisabledByEnv()) return { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  if (!isAppleSilicon()) {
    return { available: false, reason: 'requires Apple Silicon macOS' };
  }
  const binary = await ensureAfmBinary();
  if (!binary)
    return { available: false, reason: 'bridge binary unavailable (swiftc/source missing)' };
  const result = await runner(binary, ['availability'], { timeoutMs: 30_000 });
  if (!result.ok) {
    return { available: false, reason: `probe failed: ${result.stderr.slice(0, 200)}` };
  }
  try {
    const parsed = normalizeAppleIntelligenceAvailability(
      parseSafeJsonInput(result.stdout.trim(), 'Apple Intelligence availability response')
    );
    if (parsed) return parsed;
  } catch {
    // fall through to the stable unavailable result below
  }
  return { available: false, reason: `unparseable probe output: ${result.stdout.slice(0, 120)}` };
}

export interface AppleSpeechAvailability extends AppleIntelligenceAvailability {
  locale: string;
  asset_status: 'installed' | 'supported' | 'downloading' | 'unsupported' | 'unknown';
}

const cachedSpeechAvailability = new Map<
  string,
  { checkedAt: number; value: AppleSpeechAvailability }
>();

export function _resetAppleSpeechAvailabilityCacheForTests(): void {
  cachedSpeechAvailability.clear();
}

export function normalizeAppleSpeechAvailability(
  value: unknown
): AppleSpeechAvailability | undefined {
  const base = normalizeAppleIntelligenceAvailability(value);
  if (
    !base ||
    !isRecord(value) ||
    typeof value.locale !== 'string' ||
    !value.locale.trim() ||
    !['installed', 'supported', 'downloading', 'unsupported', 'unknown'].includes(
      String(value.asset_status)
    ) ||
    (base.available && value.asset_status !== 'installed')
  )
    return undefined;
  return {
    ...base,
    locale: value.locale,
    asset_status: value.asset_status as AppleSpeechAvailability['asset_status'],
  };
}

/** Locale and installed-asset readiness, independent of the Foundation Models text model.
 * The native probe only reads Speech metadata; it never downloads or reserves assets.
 */
export async function probeAppleSpeechAvailability(
  options: { locale?: string } = {}
): Promise<AppleSpeechAvailability> {
  const locale = resolveAppleSpeechLocale(options.locale);
  const unavailable = (reason: string): AppleSpeechAvailability => ({
    available: false,
    locale,
    asset_status: 'unknown',
    reason,
  });
  if (bridgeDisabledByEnv()) return unavailable('disabled via KYBERION_APPLE_FM');
  const cached = cachedSpeechAvailability.get(locale);
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) return cached.value;
  let value: AppleSpeechAvailability;
  if (!isAppleSilicon()) {
    value = unavailable('requires Apple Silicon macOS');
  } else {
    const binary = await ensureAfmBinary();
    if (!binary) {
      value = unavailable('bridge binary unavailable (swiftc/source missing)');
    } else {
      const result = await runner(binary, ['speech-availability', '--locale', locale], {
        timeoutMs: 30_000,
      });
      value = result.ok
        ? (parseLastJsonLine(result.stdout, '{"available"', normalizeAppleSpeechAvailability) ??
          unavailable('unparseable speech readiness response'))
        : unavailable('speech readiness probe failed');
    }
  }
  cachedSpeechAvailability.set(locale, { checkedAt: Date.now(), value });
  return value;
}

export interface AppleFmPromptOptions {
  instructions?: string;
  timeoutMs?: number;
}

/**
 * One text→text round trip on the on-device model. Returns null on ANY
 * failure — callers must treat this as best-effort assist, never a
 * load-bearing reasoning step.
 */
export async function appleFmPrompt(
  promptText: string,
  options: AppleFmPromptOptions = {}
): Promise<string | null> {
  const availability = await probeAppleIntelligence();
  if (!availability.available) return null;
  const binary = afmBinaryPath();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const args = ['prompt', '--timeout', String(Math.ceil(timeoutMs / 1000))];
  if (options.instructions) args.push('--instructions', options.instructions);
  const result = await runner(binary, args, { stdin: promptText, timeoutMs: timeoutMs + 5_000 });
  if (!result.ok) {
    logger.warn(`[apple-fm] prompt failed: ${result.stderr.slice(0, 200)}`);
    return null;
  }
  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
}

/**
 * Local intent pre-classification. The task rides in the prompt body — the
 * ~3B model follows embedded tasks far more reliably than session
 * instructions. Returns a category from `categories` or null.
 */
export async function classifyLocallyWithAppleFm(
  text: string,
  categories: string[],
  options: { timeoutMs?: number } = {}
): Promise<string | null> {
  if (categories.length === 0) return null;
  const response = await appleFmPrompt(
    [
      // i18n-exempt: JA LLM prompt (model input)
      `次のテキストを分類してください。カテゴリ: ${categories.join(' / ')}。`,
      // i18n-exempt: JA LLM prompt (model input)
      'カテゴリ名のみを返答してください。',
      '',
      // i18n-exempt: JA LLM prompt (model input)
      `テキスト: ${text.slice(0, 2000)}`,
    ].join('\n'),
    { timeoutMs: options.timeoutMs ?? 20_000 }
  );
  if (!response) return null;
  const normalized = response.trim().toLowerCase();
  return categories.find((category) => normalized === category.toLowerCase()) || null;
}

function normalizeTextPayload(value: unknown): { text: string } | undefined {
  return isRecord(value) && typeof value.text === 'string' ? { text: value.text } : undefined;
}

/**
 * On-device image understanding via the Vision framework (OCR + scene
 * labels; no LLM). Ideal for verifying rendered artifacts — "does the
 * screenshot actually show the headline?" — per the designer principle of
 * judging the rendered result. Returns null when unavailable or on failure.
 *
 * Note: macOS Vision emits loader warnings on stdout before the JSON line,
 * so we parse the LAST parseable JSON line rather than the whole stream.
 */
export async function recognizeImageLocallyWithAppleVision(
  imagePath: string,
  options: { timeoutMs?: number; language?: string } = {}
): Promise<AppleVisionResult | null> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  const deadlineAtMs = Date.now() + timeoutMs;
  if (bridgeDisabledByEnv()) return null;
  if (!isAppleSilicon()) return null;
  const authorizedImage = authorizeNativeInput(imagePath);
  if (!authorizedImage) return null;
  const binary = await ensureAfmBinary({ deadlineAtMs });
  if (!binary) return null;
  const currentImage = authorizeNativeInput(authorizedImage);
  if (!currentImage || currentImage !== authorizedImage) return null;
  const args = ['vision', '--image', currentImage];
  if (options.language) args.push('--language', options.language);
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) return null;
  const result = await runner(binary, args, { timeoutMs: remainingMs });
  if (!result.ok) {
    logger.warn(`[apple-fm] vision failed: ${result.stderr.slice(0, 200)}`);
    return null;
  }
  const lines = result.stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    const start = line.indexOf('{"text"');
    if (start === -1) continue;
    try {
      const parsed = normalizeAppleVisionResult(
        parseSafeJsonInput(line.slice(start), 'Apple Vision response')
      );
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  logger.warn(`[apple-fm] vision output unparseable: ${result.stdout.slice(0, 120)}`);
  return null;
}

export interface RenderedTextVerification {
  ok: boolean;
  missing: string[];
  /** Recognized text, for the reviewer's evidence trail. */
  recognized_text: string;
}

/**
 * Deterministic artifact QA: does the RENDERED image actually show the
 * expected strings? (designer principle: judge the render, not the source).
 * Whitespace-insensitive containment; returns null when Vision is
 * unavailable so callers fall back to manual review.
 */
export async function verifyRenderedTextWithAppleVision(
  imagePath: string,
  expectedStrings: string[],
  options: { timeoutMs?: number } = {}
): Promise<RenderedTextVerification | null> {
  const vision = await recognizeImageLocallyWithAppleVision(imagePath, options);
  if (!vision) return null;
  const haystack = vision.text.replace(/\s+/g, '').toLowerCase();
  const missing = expectedStrings.filter(
    (expected) => !haystack.includes(expected.replace(/\s+/g, '').toLowerCase())
  );
  return { ok: missing.length === 0, missing, recognized_text: vision.text };
}

/**
 * On-device speech-to-text via the SpeechAnalyzer/SpeechTranscriber stack
 * (macOS 26+). Meeting audio, voice memos, requirements-hearing recordings —
 * transcribed locally, nothing leaves the machine. Returns null when the
 * stack, locale model, or bridge is unavailable.
 */
export async function transcribeAudioLocallyWithAppleSpeech(
  audioPath: string,
  options: { locale?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  if (bridgeDisabledByEnv()) return null;
  if (!isAppleSilicon()) return null;
  const binary = await ensureAfmBinary();
  if (!binary) return null;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const result = await runner(
    binary,
    [
      'transcribe',
      '--audio',
      audioPath,
      '--locale',
      resolveAppleSpeechLocale(options.locale),
      '--timeout',
      String(Math.ceil(timeoutMs / 1000)),
    ],
    { timeoutMs: timeoutMs + 10_000 }
  );
  if (!result.ok) {
    logger.warn(`[apple-fm] transcribe failed: ${result.stderr.slice(0, 200)}`);
    return null;
  }
  const parsed = parseLastJsonLine(result.stdout, '{"text"', normalizeTextPayload);
  const text = parsed?.text.trim() || '';
  return text.length > 0 ? text : null;
}

export interface AppleImageGenerationResult {
  path: string;
  style: string;
}

export interface AppleImageGenerationAvailability {
  available: boolean;
  reason?: string;
}

export function normalizeAppleImageGenerationAvailability(
  value: unknown
): AppleImageGenerationAvailability | undefined {
  return normalizeAppleIntelligenceAvailability(value);
}

export function normalizeAppleImageGenerationResult(
  value: unknown
): AppleImageGenerationResult | undefined {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path.trim()) return undefined;
  if (value.style !== undefined && typeof value.style !== 'string') return undefined;
  return { path: value.path, style: typeof value.style === 'string' ? value.style : '' };
}

let cachedImageGenerationAvailability: {
  checkedAt: number;
  value: AppleImageGenerationAvailability;
} | null = null;

export function _resetAppleImageGenerationAvailabilityCacheForTests(): void {
  cachedImageGenerationAvailability = null;
}

/**
 * Probe Image Playground itself, separately from Foundation Models text
 * availability. A Mac can expose the text model while Image Playground is
 * still unavailable because its image model is not enabled for the device.
 */
export async function probeAppleImageGeneration(): Promise<AppleImageGenerationAvailability> {
  if (bridgeDisabledByEnv()) return { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  if (
    cachedImageGenerationAvailability &&
    Date.now() - cachedImageGenerationAvailability.checkedAt < AVAILABILITY_TTL_MS
  ) {
    return cachedImageGenerationAvailability.value;
  }

  let value: AppleImageGenerationAvailability;
  if (bridgeDisabledByEnv()) {
    value = { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  } else if (!isAppleSilicon()) {
    value = { available: false, reason: 'requires Apple Silicon macOS' };
  } else {
    const binary = await ensureAfmBinary();
    if (!binary) {
      value = { available: false, reason: 'bridge binary unavailable (swiftc/source missing)' };
    } else {
      const result = await runner(binary, ['imagine-availability'], { timeoutMs: 30_000 });
      if (!result.ok) {
        value = { available: false, reason: `probe failed: ${result.stderr.slice(0, 200)}` };
      } else {
        const parsed = parseLastJsonLine(
          result.stdout,
          '{"available"',
          normalizeAppleImageGenerationAvailability
        );
        value = parsed || {
          available: false,
          reason: `unparseable probe output: ${result.stdout.slice(0, 120)}`,
        };
      }
    }
  }

  cachedImageGenerationAvailability = { checkedAt: Date.now(), value };
  return value;
}

/**
 * On-device image generation via Image Playground (ImageCreator). Requires
 * Image Playground to be enabled on the device — commonly notSupported even
 * where the text model works, so callers MUST treat null as the normal case
 * and keep their existing asset path (SVG authoring, media actuator).
 */
export async function generateImageLocallyWithApplePlayground(
  prompt: string,
  outPath: string,
  options: { style?: string; timeoutMs?: number } = {}
): Promise<AppleImageGenerationResult | null> {
  if (bridgeDisabledByEnv()) return null;
  if (!isAppleSilicon()) return null;
  const binary = await ensureAfmBinary();
  if (!binary) return null;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const args = [
    'imagine',
    '--prompt',
    prompt,
    '--out',
    outPath,
    '--timeout',
    String(Math.ceil(timeoutMs / 1000)),
  ];
  if (options.style) args.push('--style', options.style);
  const result = await runner(binary, args, { timeoutMs: timeoutMs + 10_000 });
  if (!result.ok) {
    logger.warn(`[apple-fm] imagine failed: ${result.stderr.slice(0, 200)}`);
    return null;
  }
  return parseLastJsonLine(result.stdout, '{"path"', normalizeAppleImageGenerationResult);
}

// ----- SpeechToTextBridge adapter (meeting minutes / requirements audio) -----

/** On-device SpeechAnalyzer: audio never leaves the machine. */
const APPLE_SPEECH_CAPABILITIES: SpeechToTextCapabilities = {
  timestamps: false,
  granularity: 'none',
  local_only: true,
};

/**
 * Adapts the on-device STT lane to the repo-wide SpeechToTextBridge
 * contract, so in-room minutes recording and requirements-elicitation
 * pipelines transcribe locally with zero configuration. BCP-47 language
 * maps straight to the SpeechTranscriber locale (default ja-JP).
 */
export function createAppleSpeechToTextBridge(): SpeechToTextBridge {
  return {
    name: 'apple-speech',
    capabilities: APPLE_SPEECH_CAPABILITIES,
    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      const audioAbs = rootResolve(input.audioPath);
      if (!safeExistsSync(audioAbs)) {
        throw new Error(`[stt-bridge:apple-speech] audio file not found: ${input.audioPath}`);
      }
      const language = resolveAppleSpeechLocale(input.language);
      const text = await transcribeAudioLocallyWithAppleSpeech(audioAbs, { locale: language });
      if (text === null) {
        throw new Error(
          '[stt-bridge:apple-speech] on-device transcription failed or became unavailable'
        );
      }
      const parsed = path.parse(audioAbs);
      const outputPath = input.outputPath
        ? rootResolve(input.outputPath)
        : path.join(parsed.dir, `${parsed.name}.transcript.txt`);
      safeWriteFile(outputPath, `${text}\n`, { encoding: 'utf8', mkdir: true });
      return {
        text,
        language,
        written_to: outputPath,
        backend: 'apple-speech',
        capabilities: APPLE_SPEECH_CAPABILITIES,
      };
    },
  };
}

/**
 * Bootstrap helper: register the Apple STT bridge when the device supports
 * it. Call AFTER installShellSpeechToTextBridgeIfAvailable — an explicit
 * KYBERION_STT_COMMAND always wins over the implicit local capability.
 */
export async function installAppleSpeechToTextBridgeIfAvailable(): Promise<boolean> {
  if (bridgeDisabledByEnv()) return false;
  if (
    getRegisteredEnvText('KYBERION_STT_COMMAND')?.trim() ||
    getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_COMMAND')?.trim()
  ) {
    return false;
  }
  const availability = await probeAppleSpeechAvailability();
  if (!availability.available) return false;
  if (getSpeechToTextBridges().some((bridge) => bridge.name === 'apple-speech')) return true;
  registerSpeechToTextBridge(createAppleSpeechToTextBridge(), {
    provenance: 'builtin',
    source: 'apple-intelligence-bridge',
  });
  logger.info('[stt-bridge] installed AppleSpeechToTextBridge (on-device SpeechAnalyzer)');
  return true;
}

/** macOS frameworks print loader noise to stdout; scan for the last JSON line. */
function parseLastJsonLine<T>(
  stdout: string,
  marker: string,
  normalize: (value: unknown) => T | undefined
): T | null {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    const start = line.indexOf(marker);
    if (start === -1) continue;
    try {
      const parsed = normalize(
        parseSafeJsonInput(line.slice(start), 'Apple Intelligence response')
      );
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/** Local one-to-few sentence summary (mission/work-item digests, UI strings). */
export async function summarizeLocallyWithAppleFm(
  text: string,
  options: { maxSentences?: number; language?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  const maxSentences = options.maxSentences ?? 1;
  const language = options.language ?? resolveLocale();
  return appleFmPrompt(
    [
      language === 'ja'
        ? // i18n-exempt: JA LLM prompt (model input)
          `次のテキストを日本語で${maxSentences}文に要約してください。要約文のみを返してください。`
        : `Summarize the following text in at most ${maxSentences} sentence(s), in ${language}. Return only the summary.`,
      '',
      '---',
      text.slice(0, 6000),
      '---',
    ].join('\n'),
    { timeoutMs: options.timeoutMs ?? 30_000 }
  );
}

// ---------------------------------------------------------------------------
// macOS 27.2 Apple Intelligence developer lanes (version-gated matrix)
//
// `afm capabilities` reports one JSON matrix: OS version, model availability,
// and per-lane flags. Lanes that need a LIVE probe (Image Playground, PCC)
// report `null` and are resolved through their dedicated probes on demand.
// Every helper below degrades to null/{available:false,reason} — callers
// keep their existing path, per the probe-and-degrade contract.
// ---------------------------------------------------------------------------

export interface AppleOsVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface AppleFmLaneStates {
  text: boolean;
  vision_ocr: boolean;
  speech: boolean;
  /** null = needs the live imagine-availability probe. */
  imagine: boolean | null;
  multimodal: boolean;
  dynamic_profiles: boolean;
  /** null = needs the live pcc-availability probe. */
  pcc: boolean | null;
  coreai: boolean;
  shortcuts: boolean;
}

export interface AppleIntelligenceCapabilities {
  os: AppleOsVersion;
  model_available: boolean;
  model_reason?: string;
  lanes: AppleFmLaneStates;
  is_27_or_later: boolean;
}

function normalizeOsVersion(value: unknown): AppleOsVersion | undefined {
  if (
    !isRecord(value) ||
    typeof value.major !== 'number' ||
    typeof value.minor !== 'number' ||
    typeof value.patch !== 'number'
  ) {
    return undefined;
  }
  return { major: value.major, minor: value.minor, patch: value.patch };
}

/**
 * Strict normalizer for the `afm capabilities` matrix. Boolean lanes must be
 * booleans; `imagine`/`pcc` may additionally be `null` (live-probe lanes).
 * Anything else makes the whole matrix unparseable → undefined.
 */
export function normalizeAppleIntelligenceCapabilities(
  value: unknown
): AppleIntelligenceCapabilities | undefined {
  if (!isRecord(value)) return undefined;
  const os = normalizeOsVersion(value.os);
  if (!os || !isRecord(value.lanes)) return undefined;
  const lanes = value.lanes;
  const requiredBooleanLanes = [
    'text',
    'vision_ocr',
    'speech',
    'multimodal',
    'dynamic_profiles',
    'coreai',
    'shortcuts',
  ] as const;
  for (const lane of requiredBooleanLanes) {
    if (typeof lanes[lane] !== 'boolean') return undefined;
  }
  const nullableLane = (name: 'imagine' | 'pcc'): boolean | null | undefined => {
    const raw: unknown = lanes[name];
    if (typeof raw === 'boolean') return raw;
    if (raw === null) return null;
    return undefined;
  };
  const imagine = nullableLane('imagine');
  const pcc = nullableLane('pcc');
  if (imagine === undefined || pcc === undefined) return undefined;
  const modelAvailable = value.model;
  const model_available =
    isRecord(modelAvailable) && typeof modelAvailable.available === 'boolean'
      ? modelAvailable.available
      : false;
  return {
    os,
    model_available,
    ...(isRecord(modelAvailable) &&
    typeof modelAvailable.reason === 'string' &&
    modelAvailable.reason
      ? { model_reason: modelAvailable.reason }
      : {}),
    lanes: {
      text: lanes.text as boolean,
      vision_ocr: lanes.vision_ocr as boolean,
      speech: lanes.speech as boolean,
      imagine,
      multimodal: lanes.multimodal as boolean,
      dynamic_profiles: lanes.dynamic_profiles as boolean,
      pcc,
      coreai: lanes.coreai as boolean,
      shortcuts: lanes.shortcuts as boolean,
    },
    is_27_or_later: os.major >= 27,
  };
}

let cachedCapabilities: { checkedAt: number; value: AppleIntelligenceCapabilities | null } | null =
  null;

export function _resetAppleIntelligenceCapabilitiesCacheForTests(): void {
  cachedCapabilities = null;
}

/**
 * Version-gated capability matrix from `afm capabilities`, cached 10 minutes.
 * Returns null on any failure (platform, opt-out, toolchain, probe) — the
 * same degrade contract as every other entry point.
 */
export async function probeAppleIntelligenceCapabilities(): Promise<AppleIntelligenceCapabilities | null> {
  if (bridgeDisabledByEnv()) return null;
  if (cachedCapabilities && Date.now() - cachedCapabilities.checkedAt < AVAILABILITY_TTL_MS) {
    return cachedCapabilities.value;
  }
  let value: AppleIntelligenceCapabilities | null = null;
  if (!bridgeDisabledByEnv() && isAppleSilicon()) {
    const binary = await ensureAfmBinary();
    if (binary) {
      const result = await runner(binary, ['capabilities'], { timeoutMs: 30_000 });
      if (result.ok) {
        try {
          value =
            normalizeAppleIntelligenceCapabilities(
              parseSafeJsonInput(result.stdout.trim(), 'Apple Intelligence capabilities response')
            ) ?? null;
        } catch {
          value = null;
        }
      }
    }
  }
  cachedCapabilities = { checkedAt: Date.now(), value };
  return value;
}

export type AppleLaneKey =
  | 'text'
  | 'vision_ocr'
  | 'speech'
  | 'imagine'
  | 'multimodal'
  | 'dynamic_profiles'
  | 'pcc'
  | 'coreai'
  | 'shortcuts'
  | 'evaluations';

export interface AppleLaneGate {
  available: boolean;
  reason?: string;
}

const LANE_UNAVAILABLE_REASONS: Partial<Record<AppleLaneKey, string>> = {
  text: 'on-device model unavailable',
  vision_ocr: 'Vision framework unavailable',
  speech: 'on-device speech unavailable',
  multimodal: 'multimodal prompting requires macOS 27+ with an available model',
  dynamic_profiles: 'dynamic sessions require macOS 27+ with an available model',
  coreai: 'Core AI requires macOS 27+',
  shortcuts: 'Shortcuts CLI unavailable',
};

/**
 * Gate for one capability lane. `imagine`/`pcc`/`evaluations` fall through to
 * their dedicated live/compile probes; every other lane reads the cached
 * capability matrix. Never throws — callers branch on `available`.
 */
export async function gateAppleLane(lane: AppleLaneKey): Promise<AppleLaneGate> {
  if (bridgeDisabledByEnv()) return { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  if (!isAppleSilicon()) return { available: false, reason: 'requires Apple Silicon macOS' };
  if (lane === 'speech') {
    const probe = await probeAppleSpeechAvailability();
    return probe.available
      ? { available: true }
      : { available: false, reason: probe.reason || 'Speech assets unavailable for this locale' };
  }
  if (lane === 'imagine') {
    const probe = await probeAppleImageGeneration();
    return probe.available
      ? { available: true }
      : { available: false, reason: probe.reason || 'Image Playground unavailable' };
  }
  if (lane === 'pcc') {
    const probe = await probeApplePcc();
    return probe.available
      ? { available: true }
      : { available: false, reason: probe.reason || 'Private Cloud Compute unavailable' };
  }
  if (lane === 'coreai') {
    return probeAppleCoreAi();
  }
  if (lane === 'evaluations') {
    const probe = await probeAppleEvaluations();
    return probe.available
      ? { available: true }
      : { available: false, reason: probe.reason || 'Evaluations framework unavailable' };
  }
  const caps = await probeAppleIntelligenceCapabilities();
  if (!caps) return { available: false, reason: 'capability matrix unavailable (probe failed)' };
  const value = caps.lanes[lane as keyof AppleFmLaneStates];
  if (value === true) return { available: true };
  const baseReason = LANE_UNAVAILABLE_REASONS[lane] || `lane ${lane} unavailable`;
  const reason =
    caps.model_available || !caps.model_reason
      ? baseReason
      : `${baseReason} (${caps.model_reason})`;
  return { available: false, reason };
}

// ----- multimodal prompting (macOS 27+) -----

/**
 * One image+text round trip on the on-device model (macOS 27+ multimodal
 * prompting). Gated by the `multimodal` lane; returns null when the OS,
 * model, or image makes the lane unusable — callers fall back to the Vision
 * OCR lane (recognizeImageLocallyWithAppleVision) for text-only extraction.
 */
function authorizeNativeInput(filePath: string): string | null {
  try {
    const lexical = pathResolver.rootResolve(filePath);
    validateFileSize(lexical, 512);
    const resolved = safeRealpath(lexical);
    // Validate content permission on both lexical and canonical paths before
    // letting a native framework read outside the Node I/O boundary.
    validateFileSize(resolved, 512);
    if (!safeStat(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

export async function appleFmPromptWithImage(
  promptText: string,
  imagePath: string,
  options: AppleFmPromptOptions = {}
): Promise<string | null> {
  const authorizedImage = authorizeNativeInput(imagePath);
  if (!authorizedImage) return null;
  const gate = await gateAppleLane('multimodal');
  if (!gate.available) {
    logger.warn(`[apple-fm] multimodal gated: ${gate.reason}`);
    return null;
  }
  const binary = await ensureAfmBinary();
  if (!binary) return null;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const args = ['prompt', '--timeout', String(Math.ceil(timeoutMs / 1000))];
  if (options.instructions) args.push('--instructions', options.instructions);
  const currentImage = authorizeNativeInput(authorizedImage);
  if (!currentImage || currentImage !== authorizedImage) return null;
  args.push('--image', currentImage);
  const result = await runner(binary, args, {
    stdin: promptText,
    timeoutMs: timeoutMs + 5_000,
  });
  if (!result.ok) {
    logger.warn(`[apple-fm] multimodal prompt failed: ${result.stderr.slice(0, 200)}`);
    return null;
  }
  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
}

// ----- dynamic sessions (macOS 27+ DynamicInstructions) -----

export interface AppleFmSessionRequest {
  prompt: string;
  /** Replaces the session instructions for this request (DynamicInstructions). */
  instructions?: string;
  /** Vision tools the model may call for this request: ocr / barcode. */
  tools?: Array<'ocr' | 'barcode'>;
}

export interface AppleFmSessionResponse {
  index: number;
  content?: string;
  error?: string;
}

/**
 * Run a sequence of requests through ONE session whose instructions and
 * tools are switched per request (macOS 27+ dynamic sessions). Each request
 * becomes one stdin JSONL line; each response is one stdout JSONL line.
 * Returns null when the lane is gated or the run fails; returns [] only for
 * an empty request list.
 */
export async function appleFmSessionRequests(
  requests: AppleFmSessionRequest[],
  options: { timeoutMs?: number } = {}
): Promise<AppleFmSessionResponse[] | null> {
  const gate = await gateAppleLane('dynamic_profiles');
  if (!gate.available) {
    logger.warn(`[apple-fm] session gated: ${gate.reason}`);
    return null;
  }
  if (requests.length === 0) return [];
  const binary = await ensureAfmBinary();
  if (!binary) return null;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const stdinPayload =
    requests
      .map((request) => {
        const wire: Record<string, unknown> = { prompt: request.prompt };
        if (request.instructions) wire.instructions = request.instructions;
        if (request.tools?.length) wire.tools = request.tools;
        return JSON.stringify(wire);
      })
      .join('\n') + '\n';
  const result = await runner(
    binary,
    ['session', '--timeout', String(Math.ceil(timeoutMs / 1000))],
    {
      stdin: stdinPayload,
      timeoutMs: timeoutMs + 5_000,
    }
  );
  if (!result.ok) {
    logger.warn(`[apple-fm] session failed: ${result.stderr.slice(0, 200)}`);
    return null;
  }
  const responses: AppleFmSessionResponse[] = [];
  const seen = new Set<number>();
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue; // framework loader noise
    try {
      const parsed = parseSafeJsonInput(line, 'Apple Intelligence session response');
      if (isRecord(parsed) && typeof parsed.index === 'number') {
        if (
          !Number.isInteger(parsed.index) ||
          parsed.index < 0 ||
          parsed.index >= requests.length ||
          seen.has(parsed.index) ||
          (typeof parsed.content !== 'string' && typeof parsed.error !== 'string')
        )
          return null;
        seen.add(parsed.index);
        responses.push({
          index: parsed.index,
          ...(typeof parsed.content === 'string' ? { content: parsed.content } : {}),
          ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
        });
      }
    } catch {
      continue;
    }
  }
  return responses.length === requests.length ? responses.sort((a, b) => a.index - b.index) : null;
}

// ----- Private Cloud Compute (AFM 3 Cloud) probe -----

export interface ApplePccQuota {
  limit_reached: boolean;
  approaching: boolean | null;
  reset_date: string | null;
}

export interface ApplePccProbe {
  available: boolean;
  class:
    | 'available'
    | 'device_not_eligible'
    | 'system_not_ready'
    | 'unavailable_other'
    | 'os_too_old'
    | 'unknown';
  reason?: string;
  quota?: ApplePccQuota | null;
}

const PCC_PROBE_CLASSES = new Set([
  'available',
  'device_not_eligible',
  'system_not_ready',
  'unavailable_other',
  'os_too_old',
]);

export function normalizeApplePccProbe(value: unknown): ApplePccProbe | undefined {
  if (!isRecord(value) || typeof value.available !== 'boolean') return undefined;
  const cls =
    typeof value.class === 'string' && PCC_PROBE_CLASSES.has(value.class)
      ? value.class
      : 'unavailable_other';
  let quota: ApplePccQuota | null = null;
  if (isRecord(value.quota) && typeof value.quota.limit_reached === 'boolean') {
    quota = {
      limit_reached: value.quota.limit_reached,
      approaching: typeof value.quota.approaching === 'boolean' ? value.quota.approaching : null,
      reset_date: typeof value.quota.reset_date === 'string' ? value.quota.reset_date : null,
    };
  }
  return {
    available: value.available,
    class: cls as ApplePccProbe['class'],
    ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {}),
    quota,
  };
}

let cachedPccProbe: { checkedAt: number; value: ApplePccProbe } | null = null;

export function _resetApplePccProbeCacheForTests(): void {
  cachedPccProbe = null;
}

/**
 * Private Cloud Compute (server-side AFM) availability probe. Managed
 * entitlements are the normal gate here — an `unavailable` result with a
 * classified reason is the EXPECTED outcome on most devices, not an error.
 */
export async function probeApplePcc(): Promise<ApplePccProbe> {
  if (bridgeDisabledByEnv())
    return { available: false, class: 'unknown', reason: 'disabled via KYBERION_APPLE_FM' };
  if (cachedPccProbe && Date.now() - cachedPccProbe.checkedAt < AVAILABILITY_TTL_MS) {
    return cachedPccProbe.value;
  }
  let value: ApplePccProbe;
  if (bridgeDisabledByEnv()) {
    value = { available: false, class: 'unknown', reason: 'disabled via KYBERION_APPLE_FM' };
  } else if (!isAppleSilicon()) {
    value = {
      available: false,
      class: 'device_not_eligible',
      reason: 'requires Apple Silicon macOS',
    };
  } else {
    const binary = await ensureAfmBinary();
    if (!binary) {
      value = {
        available: false,
        class: 'unknown',
        reason: 'bridge binary unavailable (swiftc/source missing)',
      };
    } else {
      const result = await runner(binary, ['pcc-availability'], { timeoutMs: 45_000 });
      if (!result.ok) {
        value = {
          available: false,
          class: 'unknown',
          reason: `probe failed: ${result.stderr.slice(0, 200)}`,
        };
      } else {
        value = parseLastJsonLine(result.stdout, '{"available"', normalizeApplePccProbe) || {
          available: false,
          class: 'unknown',
          reason: `unparseable probe output: ${result.stdout.slice(0, 120)}`,
        };
      }
    }
  }
  cachedPccProbe = { checkedAt: Date.now(), value };
  return value;
}

// ----- Core AI lane (macOS 27+) -----

export interface AppleCoreAiAvailability {
  available: boolean;
  reason?: string;
}

export function normalizeAppleCoreAiAvailability(
  value: unknown
): AppleCoreAiAvailability | undefined {
  return normalizeAppleIntelligenceAvailability(value);
}

let cachedCoreAiAvailability: { checkedAt: number; value: AppleCoreAiAvailability } | null = null;

export function _resetAppleCoreAiAvailabilityCacheForTests(): void {
  cachedCoreAiAvailability = null;
}

/** Core AI framework availability (macOS 27+; dlopen probe on the Swift side). */
export async function probeAppleCoreAi(): Promise<AppleCoreAiAvailability> {
  if (bridgeDisabledByEnv()) return { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  if (
    cachedCoreAiAvailability &&
    Date.now() - cachedCoreAiAvailability.checkedAt < AVAILABILITY_TTL_MS
  ) {
    return cachedCoreAiAvailability.value;
  }
  let value: AppleCoreAiAvailability;
  if (bridgeDisabledByEnv()) {
    value = { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  } else if (!isAppleSilicon()) {
    value = { available: false, reason: 'requires Apple Silicon macOS' };
  } else {
    const binary = await ensureAfmBinary();
    if (!binary) {
      value = { available: false, reason: 'bridge binary unavailable (swiftc/source missing)' };
    } else {
      const result = await runner(binary, ['coreai-availability'], { timeoutMs: 30_000 });
      if (!result.ok) {
        value = { available: false, reason: `probe failed: ${result.stderr.slice(0, 200)}` };
      } else {
        value = parseLastJsonLine(
          result.stdout,
          '{"available"',
          normalizeAppleCoreAiAvailability
        ) || {
          available: false,
          reason: `unparseable probe output: ${result.stdout.slice(0, 120)}`,
        };
      }
    }
  }
  cachedCoreAiAvailability = { checkedAt: Date.now(), value };
  return value;
}

export interface AppleCoreAiTensor {
  shape: number[];
  values: number[];
}

/**
 * Run one inference function of a user-supplied .aimodel asset through Core
 * AI (macOS 27+). Float32 NDArray inputs ride as
 * `{"<name>":{"shape":[...],"values":[floats]}}`; the requested output comes
 * back as `{"<name>":[floats]}`. Gated by the `coreai` lane; null on any
 * failure (asset missing, function missing, OS gate) with the reason logged.
 */
export async function appleCoreAiRun(
  assetPath: string,
  functionName: string,
  inputs: Record<string, AppleCoreAiTensor>,
  outputName: string,
  options: { timeoutMs?: number } = {}
): Promise<Record<string, number[]> | null> {
  const authorizedAsset = authorizeNativeInput(assetPath);
  if (!authorizedAsset) return null;
  for (const tensor of Object.values(inputs)) {
    if (!isRecord(tensor) || !Array.isArray(tensor.shape) || !Array.isArray(tensor.values))
      return null;
    if (!tensor.shape.every((dimension) => Number.isSafeInteger(dimension) && dimension > 0))
      return null;
    const count = tensor.shape.reduce((product, dimension) => product * dimension, 1);
    if (
      !Number.isSafeInteger(count) ||
      count !== tensor.values.length ||
      !tensor.values.every(
        (value) =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          Math.abs(value) <= 3.4028234663852886e38
      )
    )
      return null;
  }
  const gate = await gateAppleLane('coreai');
  if (!gate.available) {
    logger.warn(`[apple-fm] coreai gated: ${gate.reason}`);
    return null;
  }
  const binary = await ensureAfmBinary();
  if (!binary) return null;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const currentAsset = authorizeNativeInput(authorizedAsset);
  if (!currentAsset || currentAsset !== authorizedAsset) return null;
  const result = await runner(
    binary,
    [
      'coreai',
      'run',
      '--asset',
      currentAsset,
      '--function',
      functionName,
      '--inputs',
      JSON.stringify(inputs),
      '--output',
      outputName,
      '--timeout',
      String(Math.ceil(timeoutMs / 1000)),
    ],
    { timeoutMs: timeoutMs + 5_000 }
  );
  if (!result.ok) {
    logger.warn(`[apple-fm] coreai run failed: ${result.stderr.slice(0, 200)}`);
    return null;
  }
  for (let index = result.stdout.split('\n').length - 1; index >= 0; index -= 1) {
    const line = result.stdout.split('\n')[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = parseSafeJsonInput(line, 'Apple Core AI response');
      if (
        isRecord(parsed) &&
        typeof parsed[outputName] !== 'undefined' &&
        Array.isArray(parsed[outputName]) &&
        parsed[outputName].every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        return { [outputName]: parsed[outputName] as number[] };
      }
    } catch {
      continue;
    }
  }
  logger.warn(`[apple-fm] coreai output unparseable: ${result.stdout.slice(0, 120)}`);
  return null;
}

// ----- Evaluations lane (macOS 27+; toolchain-gated scaffold) -----

let cachedEvaluationsProbe: { checkedAt: number; value: AppleIntelligenceAvailability } | null =
  null;

export function _resetAppleEvaluationsProbeCacheForTests(): void {
  cachedEvaluationsProbe = null;
}

/**
 * Evaluations framework probe. The framework is NOT bundled in every Xcode
 * 27 toolchain (Xcode 27.1: absent — compile probe evidence in the mission
 * ledger), so availability is decided by a one-shot `import Evaluations`
 * compile probe, cached for the process lifetime (a toolchain does not
 * change under a running process).
 */
export async function probeAppleEvaluations(): Promise<AppleIntelligenceAvailability> {
  if (bridgeDisabledByEnv()) return { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  if (
    cachedEvaluationsProbe &&
    Date.now() - cachedEvaluationsProbe.checkedAt < AVAILABILITY_TTL_MS
  ) {
    return cachedEvaluationsProbe.value;
  }
  let value: AppleIntelligenceAvailability;
  if (bridgeDisabledByEnv()) {
    value = { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  } else if (!isAppleSilicon()) {
    value = { available: false, reason: 'requires Apple Silicon macOS' };
  } else {
    const caps = await probeAppleIntelligenceCapabilities();
    if (!caps || caps.os.major < 27) {
      value = { available: false, reason: 'requires macOS 27+' };
    } else {
      try {
        const workDir = pathResolver.rootResolve(SWIFT_MODULE_CACHE_DIR);
        safeMkdir(workDir, { recursive: true });
        const probeSource = path.join(workDir, 'evaluations-probe.swift');
        safeWriteFile(probeSource, 'import Evaluations\n', { encoding: 'utf8' });
        const compile = await runner(
          'swiftc',
          [
            '-module-cache-path',
            workDir,
            probeSource,
            '-o',
            path.join(workDir, 'evaluations-probe-out'),
          ],
          { timeoutMs: 120_000 }
        );
        value = compile.ok
          ? {
              available: false,
              reason: 'Evaluations runner is not implemented in this toolchain bridge',
            }
          : {
              available: false,
              reason:
                'Evaluations framework not present in this Xcode toolchain (compile probe failed)',
            };
      } catch (err) {
        value = {
          available: false,
          reason: `compile probe failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }
  cachedEvaluationsProbe = { checkedAt: Date.now(), value };
  return value;
}

/**
 * Evaluations lane (R8) — GATED SCAFFOLD. The framework ships separately
 * from FoundationModels and is absent from the Xcode 27.1 toolchain on this
 * machine. `probeAppleEvaluations()` detects the moment a toolchain provides
 * it; until then this entry point degrades with the explicit reason instead
 * of pretending to evaluate. The Swift runner subcommand lands with the
 * toolchain that ships the framework.
 */
export async function appleFmEvaluate(
  datasetPath: string,
  options: { timeoutMs?: number } = {}
): Promise<{ status: 'unavailable'; reason: string } | null> {
  void options;
  const gate = await gateAppleLane('evaluations');
  if (gate.available) {
    return {
      status: 'unavailable',
      reason: `Evaluations framework probe passed but the afm runner subcommand is not implemented yet (dataset: ${datasetPath})`,
    };
  }
  logger.warn(`[apple-fm] evaluate gated: ${gate.reason} (dataset: ${datasetPath})`);
  return null;
}
