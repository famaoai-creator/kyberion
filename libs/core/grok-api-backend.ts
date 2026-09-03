/**
 * xAI Grok API reasoning backend — OpenAI-compatible Chat Completions at
 * https://api.x.ai/v1. Mirrors the `gemini-api` / `nemotron-api` shape:
 * an API key is enough; the official host is the default endpoint.
 *
 * Auth: `XAI_API_KEY` or `KYBERION_GROK_API_KEY`.
 * Optional: `KYBERION_GROK_API_URL`, `KYBERION_GROK_API_MODEL`.
 */

import { logger } from './core.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { validateUrl } from './secure-io.js';
import {
  OpenAiCompatibleBackend,
  type OpenAiCompatibleBackendAvailability,
  type OpenAiCompatibleBackendOverrides,
} from './openai-compatible-backend.js';
import { assertReasoningEgressAllowedAtEndpoint } from './reasoning-egress-scope.js';

export const GROK_API_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
export const GROK_API_DEFAULT_MODEL = 'grok-4.6';

export function resolveGrokApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.XAI_API_KEY?.trim() || env.KYBERION_GROK_API_KEY?.trim() || undefined;
}

export function resolveGrokApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.KYBERION_GROK_API_URL?.trim() || GROK_API_DEFAULT_BASE_URL;
}

export function resolveGrokApiModel(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string
): string {
  return (
    modelOverride?.trim() ||
    env.KYBERION_GROK_API_MODEL?.trim() ||
    env.KYBERION_REASONING_MODEL?.trim() ||
    GROK_API_DEFAULT_MODEL
  );
}

export function buildGrokApiBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: OpenAiCompatibleBackendOverrides = {}
): OpenAiCompatibleBackend | null {
  const apiKey = resolveGrokApiKey(env);
  if (!apiKey) return null;
  const baseURL = resolveGrokApiBaseUrl(env);
  const backend = new OpenAiCompatibleBackend({
    baseURL,
    apiKey,
    model: overrides.model || resolveGrokApiModel(env),
    endpointPolicy: 'public',
    supportsVision: true,
    samplingParams: overrides.samplingParams,
    contextWindowTokens: overrides.contextWindowTokens,
    maxCompletionTokens: overrides.maxCompletionTokens,
    timeoutMs: overrides.timeoutMs,
    toolsEnabled: overrides.toolsEnabled,
    allowedTools: overrides.allowedTools,
  });
  logger.info(
    `[grok-api] backend ready (endpoint=${baseURL}, model=${overrides.model || resolveGrokApiModel(env)})`
  );
  return backend;
}

export async function probeGrokApiBackendAvailability(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenAiCompatibleBackendAvailability> {
  const apiKey = resolveGrokApiKey(env);
  if (!apiKey) {
    return {
      available: false,
      reason: 'XAI_API_KEY or KYBERION_GROK_API_KEY is not set',
    };
  }

  const baseURL = resolveGrokApiBaseUrl(env);
  try {
    const url = validateUrl(normalizeTrailingSlash(baseURL));
    assertReasoningEgressAllowedAtEndpoint('grok-api', url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(new URL('models', url).toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        return {
          available: false,
          reason: `xAI Grok API probe returned HTTP ${response.status}`,
        };
      }
      const payload = await response.json().catch(() => null);
      const modelIds = parseGrokModelIds(payload);
      if (!modelIds) {
        return {
          available: false,
          reason: 'xAI Grok API /models response was malformed',
        };
      }
      const selectedModel = resolveGrokApiModel(env).replace(/^xai:/u, '');
      if (!modelIds.includes(selectedModel)) {
        return {
          available: false,
          reason: `xAI Grok API model "${selectedModel}" was not returned by /models`,
        };
      }
      return { available: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeTrailingSlash(baseURL: string): string {
  return baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
}

function parseGrokModelIds(payload: unknown): string[] | null {
  try {
    const root = parseSafeJsonObjectValue(payload, 'xAI Grok API /models response');
    if (!Array.isArray(root.data)) return null;
    const modelIds: string[] = [];
    for (const [index, model] of root.data.entries()) {
      const record = parseSafeJsonObjectValue(
        model,
        `xAI Grok API /models response.data[${index}]`
      );
      if (typeof record.id !== 'string' || !record.id.trim()) return null;
      modelIds.push(record.id.trim());
    }
    return modelIds;
  } catch {
    return null;
  }
}
