import { logger } from './core.js';
import { safeExecResult } from './secure-io.js';

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
let cached: { checkedAt: number; value: WindowsLocalAssistAvailability } | null = null;

function disabledByEnv(): boolean {
  const value = String(process.env.KYBERION_WINDOWS_AI || '').toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

function configuredEndpoint(): string | null {
  const explicit = process.env.KYBERION_WINDOWS_AI_ENDPOINT;
  return explicit ? explicit.replace(/\/$/, '') : null;
}

function configuredModel(): string {
  return process.env.KYBERION_WINDOWS_AI_MODEL || DEFAULT_MODEL;
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
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as Record<string, unknown>;
  const candidates = [record.endpoint, record.Endpoint, record.url, record.Url];
  const endpoints = record.endpoints ?? record.Endpoints;
  if (Array.isArray(endpoints)) candidates.push(...endpoints);
  const found = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return (typeof found === 'string' ? found : fallback).replace(/\/$/, '');
}

async function probeUncached(): Promise<WindowsLocalAssistAvailability> {
  if (disabledByEnv()) return { available: false, reason: 'disabled via KYBERION_WINDOWS_AI' };
  if (process.platform !== 'win32') {
    return { available: false, reason: 'requires Windows' };
  }
  let configured = configuredEndpoint();
  if (!configured) {
    const cli = safeExecResult('foundry', ['server', 'status', '--output', 'json'], {
      timeoutMs: 3_000,
    });
    if (cli.status === 0) {
      try {
        const parsed = JSON.parse(cli.stdout) as { webUrls?: unknown };
        const url = Array.isArray(parsed.webUrls) ? parsed.webUrls[0] : undefined;
        if (typeof url === 'string') configured = url.replace(/\/$/, '');
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
  return { available: true, endpoint, model: configuredModel() };
}

export function resetWindowsLocalAssistAvailabilityCache(): void {
  cached = null;
}

/** Best-effort probe for Microsoft Foundry Local (or another compatible endpoint). */
export async function probeWindowsLocalAssist(): Promise<WindowsLocalAssistAvailability> {
  if (cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) return cached.value;
  const value = await probeUncached();
  cached = { checkedAt: Date.now(), value };
  return value;
}

/** Send a short, non-critical prompt to the local Windows model. */
export async function windowsLocalAssistPrompt(
  promptText: string,
  options: WindowsLocalAssistPromptOptions = {}
): Promise<string | null> {
  const availability = await probeWindowsLocalAssist();
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
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)
    ?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
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
