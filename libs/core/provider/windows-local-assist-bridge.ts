import { logger } from '../core.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { safeExecResult } from '../secure-io.js';
import { isWindows } from '../platform-facts.js';

/** Availability of the optional Windows local-LLM assist adapter. */
export interface WindowsLocalAssistAvailability {
  available: boolean;
  reason?: string;
  endpoint?: string;
  model?: string;
}

export interface WindowsLocalAssistPromptOptions {
  instructions?: string;
  timeoutMs?: number;
  model?: string;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:5272';
const DEFAULT_MODEL = 'qwen2.5-0.5b';
const AVAILABILITY_TTL_MS = 60_000;
let cached: { key: string; checkedAt: number; value: WindowsLocalAssistAvailability } | null = null;

function disabledByEnv(): boolean {
  const value = String(getRegisteredEnvText('KYBERION_WINDOWS_AI') || '')
    .trim()
    .toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

function configuredEndpoint(): string | null {
  const explicit = getRegisteredEnvText('KYBERION_WINDOWS_AI_ENDPOINT');
  return explicit?.trim() ? normalizeEndpoint(explicit) : null;
}

function configuredModel(): string {
  return getRegisteredEnvText('KYBERION_WINDOWS_AI_MODEL')?.trim() || DEFAULT_MODEL;
}

/** Accept either a server root or an OpenAI SDK base URL ending in /v1. */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/u, '').replace(/\/v1$/iu, '');
}

function probeConfiguration() {
  const configuration = {
    disabled: disabledByEnv(),
    endpoint: configuredEndpoint(),
    model: configuredModel(),
    windows: isWindows(),
  };
  return { ...configuration, key: JSON.stringify(configuration) };
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function discoverEndpoint(payload: unknown, fallback: string): string {
  try {
    const record = parseSafeJsonObjectValue(payload, 'Windows local assist availability response');
    const candidates = [record.endpoint, record.Endpoint, record.url, record.Url];
    const endpoints = record.endpoints ?? record.Endpoints;
    if (Array.isArray(endpoints)) candidates.push(...endpoints);
    const found = candidates.find((value) => typeof value === 'string' && value.length > 0);
    return normalizeEndpoint(typeof found === 'string' ? found : fallback);
  } catch {
    return fallback;
  }
}

function parseChatCompletionText(payload: unknown): string | null {
  try {
    const root = parseSafeJsonObjectValue(payload, 'Windows local assist chat response');
    if (!Array.isArray(root.choices)) return null;
    const first = root.choices[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) return null;
    const message = (first as Record<string, unknown>).message;
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
    const content = (message as Record<string, unknown>).content;
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  } catch {
    return null;
  }
}

/** Foundry HTTP inference requires the full model ID, not its CLI alias. */
function resolveFoundryModelId(model: string): string {
  const info = safeExecResult('foundry', ['model', 'info', model, '--output', 'json'], {
    timeoutMs: 3_000,
  });
  if (info.status !== 0) return model;
  try {
    const root = parseSafeJsonObjectValue(
      parseSafeJsonInput(info.stdout, 'Foundry model info'),
      'Foundry model info'
    );
    const detail = parseSafeJsonObjectValue(root.model, 'Foundry model info.model');
    return typeof detail.id === 'string' && detail.id.trim() ? detail.id.trim() : model;
  } catch {
    return model;
  }
}

async function probeUncached(
  configuration: ReturnType<typeof probeConfiguration>
): Promise<WindowsLocalAssistAvailability> {
  if (configuration.disabled)
    return { available: false, reason: 'disabled via KYBERION_WINDOWS_AI' };
  const explicitEndpoint = configuration.endpoint;
  if (!configuration.windows && !explicitEndpoint) {
    return { available: false, reason: 'requires Windows' };
  }
  let configured = explicitEndpoint;
  if (!configured) {
    const cli = safeExecResult('foundry', ['server', 'status', '--output', 'json'], {
      timeoutMs: 3_000,
    });
    if (cli.status === 0) {
      try {
        const parsed = parseSafeJsonInput(
          cli.stdout,
          'Windows local assist availability response'
        ) as { webUrls?: unknown };
        const url = Array.isArray(parsed.webUrls) ? parsed.webUrls[0] : undefined;
        if (typeof url === 'string') configured = normalizeEndpoint(url);
      } catch {
        // Fall back to the documented default endpoint below.
      }
    }
  }
  configured = configured || DEFAULT_ENDPOINT;
  const status = await requestJson(`${configured}/openai/status`, {}, 2_000);
  const models = status === null ? await requestJson(`${configured}/v1/models`, {}, 2_000) : null;
  if (status === null && models === null) {
    return { available: false, reason: 'Foundry Local endpoint unavailable' };
  }
  const endpoint = discoverEndpoint(status, configured);
  return {
    available: true,
    endpoint,
    model: explicitEndpoint ? configuration.model : resolveFoundryModelId(configuration.model),
  };
}

export function _resetWindowsLocalAssistAvailabilityCacheForTests(): void {
  cached = null;
}

/** Best-effort probe for Microsoft Foundry Local (or another compatible endpoint). */
export async function probeWindowsLocalAssist(): Promise<WindowsLocalAssistAvailability> {
  const configuration = probeConfiguration();
  if (cached?.key === configuration.key && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) {
    return cached.value;
  }
  const value = await probeUncached(configuration);
  // Settings changed during HTTP discovery: do not cache or use the old endpoint.
  if (probeConfiguration().key !== configuration.key) return probeWindowsLocalAssist();
  cached = { key: configuration.key, checkedAt: Date.now(), value };
  return value;
}

/** Send a short, non-critical prompt to the local Windows model. */
export async function windowsLocalAssistPrompt(
  promptText: string,
  options: WindowsLocalAssistPromptOptions = {}
): Promise<string | null> {
  const configuration = probeConfiguration();
  const availability = await probeWindowsLocalAssist();
  // Even a cache hit yields at await. Do not send across a settings change.
  if (probeConfiguration().key !== configuration.key) return null;
  if (!availability.available || !availability.endpoint) return null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const payload = await requestJson(
    `${availability.endpoint}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model || availability.model || configuredModel(),
        messages: [
          {
            role: 'system',
            content:
              options.instructions || 'You are a concise, privacy-preserving local assistant.',
          },
          { role: 'user', content: promptText },
        ],
        temperature: 0.2,
        stream: false,
      }),
    },
    timeoutMs
  );
  const content = parseChatCompletionText(payload);
  if (content) return content;
  logger.warn('[windows-local-ai] prompt returned no text');
  return null;
}

export async function classifyLocallyWithWindowsAi(
  text: string,
  categories: string[],
  options: { timeoutMs?: number } = {}
): Promise<string | null> {
  if (categories.length === 0) return null;
  const answer = await windowsLocalAssistPrompt(
    `Choose exactly one category from [${categories.join(', ')}] for this text. Reply with only the category.\n\n${text}`,
    {
      timeoutMs: options.timeoutMs,
      instructions: 'You classify text. Output only one supplied category.',
    }
  );
  if (!answer) return null;
  const normalized = answer.trim().toLowerCase();
  return categories.find((category) => category.toLowerCase() === normalized) || null;
}

export async function summarizeLocallyWithWindowsAi(
  text: string,
  options: { timeoutMs?: number } = {}
): Promise<string | null> {
  return windowsLocalAssistPrompt(
    `Summarize the following text in 2-3 concise sentences:\n\n${text}`,
    {
      timeoutMs: options.timeoutMs,
      instructions: 'You summarize text accurately and concisely.',
    }
  );
}
