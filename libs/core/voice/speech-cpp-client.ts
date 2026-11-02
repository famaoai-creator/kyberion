/**
 * speech.cpp client — managed binary CLI + optional OpenAI-compatible HTTP.
 *
 * Batch TTS/ASR use `speech tts` / `speech asr` (models auto-fetch on first use).
 * `speech serve` on loopback exposes /health and /v1/audio/* for voice-hub.
 */
import { getRegisteredEnvText } from '../foundation/env.js';
import { createLogger } from '../logger.js';
import { safeExistsSync, safeExecResult, safeSpawn } from '../secure-io.js';
import { resolveSpeechCppBin } from '../tool/tool-binary-resolvers.js';

export const SPEECH_CPP_PROVIDER_ID = 'speech_cpp';
export const DEFAULT_SPEECH_CPP_BASE_URL = 'http://127.0.0.1:8095';
export const DEFAULT_SPEECH_CPP_TTS_MODEL = 'qwen3-tts-0.6b';
export const DEFAULT_SPEECH_CPP_ASR_MODEL = 'qwen3-asr-0.6b';

const HEALTH_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 200;
const CLI_TIMEOUT_MS = 600_000;
const HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_HINT =
  'speech.cpp has no idle-timeout flag; stop the serve process when finished.';

const logger = createLogger('speech-cpp');

export type SpeechCppRuntimeDeps = {
  probeHealth?: (baseUrl: string) => Promise<boolean>;
  resolveBin?: () => string;
  spawn?: typeof safeSpawn;
  exec?: typeof safeExecResult;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  existsSync?: (path: string) => boolean;
};

let sidecarStartInFlight: Promise<boolean> | null = null;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function resolveSpeechCppBaseUrl(override?: string): string {
  const fromEnv = getRegisteredEnvText('KYBERION_SPEECH_CPP_URL')?.trim();
  const raw = (override?.trim() || fromEnv || DEFAULT_SPEECH_CPP_BASE_URL).trim();
  return stripTrailingSlashes(raw);
}

export function resolveSpeechCppTtsModel(override?: string): string {
  return (
    override?.trim() ||
    getRegisteredEnvText('KYBERION_SPEECH_CPP_TTS_MODEL')?.trim() ||
    DEFAULT_SPEECH_CPP_TTS_MODEL
  );
}

export function resolveSpeechCppAsrModel(override?: string): string {
  return (
    override?.trim() ||
    getRegisteredEnvText('KYBERION_SPEECH_CPP_ASR_MODEL')?.trim() ||
    DEFAULT_SPEECH_CPP_ASR_MODEL
  );
}

/** Named Qwen3-TTS voices; Japanese defaults to ono_anna. */
export function resolveSpeechCppVoice(voice: string | undefined, language: string): string {
  const trimmed = voice?.trim();
  if (trimmed) return trimmed;
  return language.trim().toLowerCase().startsWith('ja') ? 'ono_anna' : 'ryan';
}

function assertHttpBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`speech-cpp: base URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`speech-cpp: base URL must be http(s): ${raw}`);
  }
  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function autostartEnabled(): boolean {
  const raw = getRegisteredEnvText('KYBERION_SPEECH_CPP_AUTOSTART')?.trim().toLowerCase();
  if (!raw) return false;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** Space-separated models passed to `speech serve` when auto-starting (may be empty). */
function serveModels(): string[] {
  const raw = getRegisteredEnvText('KYBERION_SPEECH_CPP_SERVE_MODELS')?.trim();
  if (!raw) {
    return [resolveSpeechCppTtsModel(), resolveSpeechCppAsrModel()];
  }
  if (raw === '-' || raw.toLowerCase() === 'none') return [];
  return raw.split(/\s+/u).filter(Boolean);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeSpeechCppHealth(baseUrl = resolveSpeechCppBaseUrl()): Promise<boolean> {
  const origin = assertHttpBaseUrl(baseUrl);
  try {
    const response = await fetchWithTimeout(
      new URL('/health', origin).toString(),
      HEALTH_TIMEOUT_MS
    );
    return response.ok;
  } catch {
    return false;
  }
}

function installHint(bin: string): string {
  return (
    `Install with \`pnpm tool:setup -- --tool speech_cpp --apply\` ` +
    `(resolved bin: ${bin}), or set KYBERION_SPEECH_CPP_BIN / KYBERION_SPEECH_CPP_URL. ` +
    DEFAULT_IDLE_HINT
  );
}

async function waitUntilHealthy(baseUrl: string, deps: SpeechCppRuntimeDeps): Promise<boolean> {
  const probe = deps.probeHealth ?? probeSpeechCppHealth;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + STARTUP_TIMEOUT_MS;
  while (now() < deadline) {
    if (await probe(baseUrl)) return true;
    await sleep(STARTUP_POLL_MS);
  }
  return probe(baseUrl);
}

/**
 * Opt-in loopback sidecar: KYBERION_SPEECH_CPP_AUTOSTART=1 spawns
 * `speech serve [models…] --host … --port …` when /health is down.
 */
export async function ensureSpeechCppReachable(
  baseUrl = resolveSpeechCppBaseUrl(),
  deps: SpeechCppRuntimeDeps = {}
): Promise<boolean> {
  const probe = deps.probeHealth ?? probeSpeechCppHealth;
  if (await probe(baseUrl)) return false;

  const origin = assertHttpBaseUrl(baseUrl);
  if (!isLoopbackHost(origin.hostname)) {
    throw new Error(
      `speech-cpp: not reachable at ${baseUrl}/health ` +
        `(auto-start only supports loopback hosts; start \`speech serve\` or set KYBERION_SPEECH_CPP_URL)`
    );
  }
  if (!autostartEnabled()) {
    throw new Error(
      `speech-cpp: not reachable at ${baseUrl}/health ` +
        `(set KYBERION_SPEECH_CPP_AUTOSTART=1 to spawn a loopback serve, or start it manually)`
    );
  }

  if (!sidecarStartInFlight) {
    sidecarStartInFlight = startSidecar(origin, deps).finally(() => {
      sidecarStartInFlight = null;
    });
  }
  const started = await sidecarStartInFlight;
  if (!(await waitUntilHealthy(baseUrl, deps))) {
    const bin = (deps.resolveBin ?? resolveSpeechCppBin)();
    throw new Error(
      `speech-cpp: sidecar started but ${baseUrl}/health stayed down. ${installHint(bin)}`
    );
  }
  return started;
}

async function startSidecar(origin: URL, deps: SpeechCppRuntimeDeps): Promise<boolean> {
  const resolveBin = deps.resolveBin ?? resolveSpeechCppBin;
  const spawn = deps.spawn ?? safeSpawn;
  const existsSync = deps.existsSync ?? ((p: string) => safeExistsSync(p));
  const bin = resolveBin();
  if ((bin.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(bin)) && !existsSync(bin)) {
    throw new Error(`speech-cpp: binary not found at ${bin}. ${installHint(bin)}`);
  }

  const bindHost = origin.hostname === 'localhost' ? '127.0.0.1' : origin.hostname;
  const port = origin.port || (origin.protocol === 'https:' ? '443' : '80');
  const models = serveModels();
  const args = [...models, '--host', bindHost, '--port', port];
  logger.info(`speech-cpp: starting serve sidecar (${bin} serve ${args.join(' ')})`);

  try {
    const child = spawn(bin, ['serve', ...args], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  } catch (error) {
    throw new Error(
      `speech-cpp: failed to spawn serve (${error instanceof Error ? error.message : String(error)}). ${installHint(bin)}`
    );
  }
  return true;
}

export type SpeechCppSynthesizeInput = {
  text: string;
  outputPath: string;
  language?: string;
  voice?: string;
  model?: string;
};

export type SpeechCppSynthesizeResult = {
  provider: typeof SPEECH_CPP_PROVIDER_ID;
  output_path: string;
  model: string;
  voice: string;
  via: 'cli';
};

/** Batch TTS via `speech tts MODEL --voice … -o PATH TEXT`. */
export function synthesizeSpeechCppCli(
  input: SpeechCppSynthesizeInput,
  deps: SpeechCppRuntimeDeps = {}
): SpeechCppSynthesizeResult {
  const text = input.text.trim();
  if (!text) throw new Error('speech-cpp: text is required');
  const outputPath = input.outputPath.trim();
  if (!outputPath) throw new Error('speech-cpp: outputPath is required');

  const model = resolveSpeechCppTtsModel(input.model);
  const voice = resolveSpeechCppVoice(input.voice, input.language || 'en');
  const bin = (deps.resolveBin ?? resolveSpeechCppBin)();
  const exec = deps.exec ?? safeExecResult;
  const existsSync = deps.existsSync ?? ((p: string) => safeExistsSync(p));
  const result = exec(bin, ['tts', model, '--voice', voice, '-o', outputPath, text], {
    timeoutMs: CLI_TIMEOUT_MS,
    maxOutputMB: 4,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `speech-cpp: tts failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`
    );
  }
  if (!existsSync(outputPath)) {
    throw new Error(`speech-cpp: tts did not create ${outputPath}`);
  }
  return {
    provider: SPEECH_CPP_PROVIDER_ID,
    output_path: outputPath,
    model,
    voice,
    via: 'cli',
  };
}

export type SpeechCppTranscribeInput = {
  audioPath: string;
  language?: string;
  model?: string;
};

export type SpeechCppTranscribeResult = {
  provider: typeof SPEECH_CPP_PROVIDER_ID;
  text: string;
  model: string;
  via: 'cli' | 'http';
};

/** Batch ASR via `speech asr MODEL PATH`. */
export function transcribeSpeechCppCli(
  input: SpeechCppTranscribeInput,
  deps: SpeechCppRuntimeDeps = {}
): SpeechCppTranscribeResult {
  const audioPath = input.audioPath.trim();
  if (!audioPath) throw new Error('speech-cpp: audioPath is required');
  const existsSync = deps.existsSync ?? ((p: string) => safeExistsSync(p));
  if (!existsSync(audioPath)) {
    throw new Error(`speech-cpp: audio file not found: ${audioPath}`);
  }
  const model = resolveSpeechCppAsrModel(input.model);
  const bin = (deps.resolveBin ?? resolveSpeechCppBin)();
  const exec = deps.exec ?? safeExecResult;
  const args = ['asr', model];
  const language = input.language?.trim();
  if (language && language !== 'auto') {
    args.push('--language', language);
  }
  args.push(audioPath);
  const result = exec(bin, args, {
    timeoutMs: CLI_TIMEOUT_MS,
    maxOutputMB: 4,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `speech-cpp: asr failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`
    );
  }
  const text = String(result.stdout || '').trim();
  if (!text) throw new Error('speech-cpp: asr returned empty text');
  return {
    provider: SPEECH_CPP_PROVIDER_ID,
    text,
    model,
    via: 'cli',
  };
}

/** OpenAI-compatible POST /v1/audio/speech → WAV bytes (caller writes the file). */
export async function synthesizeSpeechCppHttp(
  input: Omit<SpeechCppSynthesizeInput, 'outputPath'> & { outputPath?: string },
  deps: SpeechCppRuntimeDeps = {}
): Promise<{
  provider: typeof SPEECH_CPP_PROVIDER_ID;
  model: string;
  voice: string;
  via: 'http';
  base_url: string;
  wav: Buffer;
}> {
  const text = input.text.trim();
  if (!text) throw new Error('speech-cpp: text is required');

  const baseUrl = resolveSpeechCppBaseUrl();
  await ensureSpeechCppReachable(baseUrl, deps);
  const voice = resolveSpeechCppVoice(input.voice, input.language || 'en');
  const model = resolveSpeechCppTtsModel(input.model);
  const response = await fetchWithTimeout(
    new URL('/v1/audio/speech', baseUrl + '/').toString(),
    HTTP_TIMEOUT_MS,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        voice,
        model,
        response_format: 'wav',
      }),
    }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `speech-cpp: HTTP speech failed (${response.status}): ${body.slice(0, 400) || response.statusText}`
    );
  }
  return {
    provider: SPEECH_CPP_PROVIDER_ID,
    model,
    voice,
    via: 'http',
    base_url: baseUrl,
    wav: Buffer.from(await response.arrayBuffer()),
  };
}
