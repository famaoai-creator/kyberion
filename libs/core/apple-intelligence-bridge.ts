import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeStat } from './secure-io.js';
import { spawnManagedProcess } from './managed-process.js';

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

export interface AppleIntelligenceAvailability {
  available: boolean;
  reason?: string;
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

let runner: AfmRunner = defaultRunner;
export function setAfmRunnerForTests(customRunner: AfmRunner | null): void {
  runner = customRunner || defaultRunner;
}

function bridgeDisabledByEnv(): boolean {
  const flag = String(process.env.KYBERION_APPLE_FM || '').toLowerCase();
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

async function ensureAfmBinary(): Promise<string | null> {
  const binary = afmBinaryPath();
  if (binaryIsFresh()) return binary;
  const source = bridgeSourcePath();
  if (!safeExistsSync(source)) return null;
  try {
    safeMkdir(path.dirname(binary), { recursive: true });
  } catch (err) {
    logger.warn(
      `[apple-fm] cannot prepare binary cache dir: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  const compile = await runner('swiftc', ['-O', source, '-o', binary], { timeoutMs: 120_000 });
  if (!compile.ok) {
    logger.warn(`[apple-fm] swiftc compile failed: ${compile.stderr.slice(0, 300)}`);
    return null;
  }
  return binary;
}

let cachedAvailability: { checkedAt: number; value: AppleIntelligenceAvailability } | null = null;
const AVAILABILITY_TTL_MS = 10 * 60 * 1000;

export function resetAppleIntelligenceAvailabilityCache(): void {
  cachedAvailability = null;
}

/**
 * Platform gate + live probe (`afm availability`), cached for 10 minutes.
 * Safe to call from any platform.
 */
export async function probeAppleIntelligence(): Promise<AppleIntelligenceAvailability> {
  if (cachedAvailability && Date.now() - cachedAvailability.checkedAt < AVAILABILITY_TTL_MS) {
    return cachedAvailability.value;
  }
  const value = await probeUncached();
  cachedAvailability = { checkedAt: Date.now(), value };
  return value;
}

async function probeUncached(): Promise<AppleIntelligenceAvailability> {
  if (bridgeDisabledByEnv()) return { available: false, reason: 'disabled via KYBERION_APPLE_FM' };
  if (process.platform !== 'darwin' || os.arch() !== 'arm64') {
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
    const parsed = JSON.parse(result.stdout.trim()) as AppleIntelligenceAvailability;
    return {
      available: Boolean(parsed.available),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
  } catch {
    return { available: false, reason: `unparseable probe output: ${result.stdout.slice(0, 120)}` };
  }
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
      `次のテキストを分類してください。カテゴリ: ${categories.join(' / ')}。`,
      'カテゴリ名のみを返答してください。',
      '',
      `テキスト: ${text.slice(0, 2000)}`,
    ].join('\n'),
    { timeoutMs: options.timeoutMs ?? 20_000 }
  );
  if (!response) return null;
  const normalized = response.trim().toLowerCase();
  return categories.find((category) => normalized.includes(category.toLowerCase())) || null;
}

export interface AppleVisionResult {
  /** OCR text (line-joined). */
  text: string;
  labels: Array<{ label: string; confidence: number }>;
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
  options: { timeoutMs?: number } = {}
): Promise<AppleVisionResult | null> {
  if (bridgeDisabledByEnv()) return null;
  if (process.platform !== 'darwin' || os.arch() !== 'arm64') return null;
  const binary = await ensureAfmBinary();
  if (!binary) return null;
  const result = await runner(binary, ['vision', '--image', imagePath], {
    timeoutMs: options.timeoutMs ?? 60_000,
  });
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
      const parsed = JSON.parse(line.slice(start)) as AppleVisionResult;
      return {
        text: String(parsed.text || ''),
        labels: Array.isArray(parsed.labels) ? parsed.labels : [],
      };
    } catch {
      continue;
    }
  }
  logger.warn(`[apple-fm] vision output unparseable: ${result.stdout.slice(0, 120)}`);
  return null;
}

/** Local one-to-few sentence summary (mission/work-item digests, UI strings). */
export async function summarizeLocallyWithAppleFm(
  text: string,
  options: { maxSentences?: number; language?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  const maxSentences = options.maxSentences ?? 1;
  const language = options.language ?? 'ja';
  return appleFmPrompt(
    [
      language === 'ja'
        ? `次のテキストを日本語で${maxSentences}文に要約してください。要約文のみを返してください。`
        : `Summarize the following text in at most ${maxSentences} sentence(s), in ${language}. Return only the summary.`,
      '',
      '---',
      text.slice(0, 6000),
      '---',
    ].join('\n'),
    { timeoutMs: options.timeoutMs ?? 30_000 }
  );
}
