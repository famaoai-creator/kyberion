import { logger } from '@agent/core/core';
import { classifyError } from '@agent/core/error-classifier';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as pathResolver from '@agent/core/path-resolver';
import { persistTrace, TraceContext } from '@agent/core/trace';
import { ensureDefaultOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import { createAjv } from '@agent/core/foundation';
import type { ValidateFunction } from 'ajv';

export type SearchAction = {
  op: 'web_search' | 'fetch_reader';
  params?: {
    query?: string;
    provider?: string;
    top_k?: number;
    url?: string;
    max_chars?: number;
  };
};

export type WebSearchStub = {
  provider: string;
  query: string;
  top_k: number;
  results: Array<Record<string, never>>;
  hint: string;
};

export type FetchReaderResult = {
  url: string;
  chars: number;
  truncated: boolean;
  text: string;
};

const SEARCH_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/search-action.schema.json'
);

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_CHARS = 8000;
const FETCH_TIMEOUT_MS = 10000;
const FETCH_BODY_CAP_BYTES = 1024 * 1024;

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = createAjv();
  cachedValidator = compileSchemaFromPath(ajv, SEARCH_SCHEMA_PATH);
  return cachedValidator;
}

function missingRequiredFields(action: SearchAction): string[] {
  const params = action.params || {};
  if (action.op === 'web_search') {
    if (!params.query?.trim()) return ['params.query'];
    return [];
  }
  if (action.op === 'fetch_reader') {
    if (!params.url?.trim()) return ['params.url'];
    return [];
  }
  return [];
}

function validateAction(input: unknown): SearchAction {
  const validate = getValidator();
  if (!validate(input)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join('; ');
    throw new Error(`search-actuator: invalid input: ${errors}`);
  }
  const action = input as SearchAction;
  const missing = missingRequiredFields(action);
  if (missing.length) {
    throw new Error(`search-actuator: missing required fields: ${missing.join(', ')}`);
  }
  return action;
}

function assertHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('search-actuator: fetch_reader requires an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('search-actuator: fetch_reader requires an absolute http(s) URL');
  }
  return parsed;
}

function stripElementBlocks(html: string, tag: 'script' | 'style'): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}[^>]*>`, 'gi');
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(pattern, ' ');
  } while (out !== prev);
  return out;
}

function stripTags(html: string): string {
  let out = html;
  while (out.includes('<')) {
    const next = out.replace(/<[^>]*>/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out;
}

function extractPlainText(html: string): string {
  const withoutTags = stripTags(stripElementBlocks(stripElementBlocks(html, 'script'), 'style'));
  return withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function webSearch(
  params: NonNullable<SearchAction['params']>
): Promise<WebSearchStub> {
  const query = params.query?.trim() ?? '';
  if (!query) {
    throw new Error('search-actuator: missing required fields: params.query');
  }
  const providerRaw = params.provider?.trim();
  const provider = providerRaw ? providerRaw : 'unconfigured';
  const top_k = params.top_k ?? DEFAULT_TOP_K;
  logger.debug(`search-actuator: web_search query="${query}" provider="${provider}"`);
  return {
    provider,
    query,
    top_k,
    results: [],
    hint: 'configure service binding',
  };
}

export async function fetchReader(
  params: NonNullable<SearchAction['params']>
): Promise<FetchReaderResult> {
  const rawUrl = params.url?.trim() ?? '';
  if (!rawUrl) {
    throw new Error('search-actuator: missing required fields: params.url');
  }
  const parsed = assertHttpUrl(rawUrl);
  const maxChars = params.max_chars ?? DEFAULT_MAX_CHARS;
  logger.debug(`search-actuator: fetch_reader url="${parsed.host}" max_chars=${maxChars}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`search-actuator: fetch_reader failed with status ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      const plain = extractPlainText(text).slice(0, maxChars);
      return {
        url: parsed.toString(),
        chars: plain.length,
        truncated: extractPlainText(text).length > maxChars,
        text: plain,
      };
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.length;
        if (received > FETCH_BODY_CAP_BYTES) break;
        chunks.push(value);
      }
    }
    try {
      await reader.cancel();
    } catch (_) {
      // Best-effort stream cleanup.
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const body = new TextDecoder().decode(merged);
    const plain = extractPlainText(body);
    const truncated = plain.length > maxChars || received > FETCH_BODY_CAP_BYTES;
    const text = plain.slice(0, maxChars);
    return { url: parsed.toString(), chars: text.length, truncated, text };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`search-actuator: fetch_reader timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleAction(action: SearchAction): Promise<unknown> {
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `search:${action.op}`,
    params: (action.params || {}) as Record<string, unknown>,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation search:${action.op} was not admitted.`}`
    );
  }
  const valid = validateAction({
    ...action,
    params: preflight.input as SearchAction['params'],
  });
  const params = valid.params || {};
  const traceCtx = new TraceContext(`search-actuator:${valid.op}`, {
    actuator: 'search-actuator',
  });
  traceCtx.addEvent('action.received', { op: valid.op });
  let result: unknown;
  try {
    switch (valid.op) {
      case 'web_search':
        result = await webSearch(params);
        break;
      case 'fetch_reader':
        result = await fetchReader(params);
        break;
      default: {
        const _exhaustive: never = valid.op;
        throw new Error(`Unsupported operation: ${String(_exhaustive)}`);
      }
    }
    traceCtx.addEvent('action.completed', { op: valid.op });
    return result;
  } catch (error: unknown) {
    const classified = classifyError(error);
    traceCtx.addEvent('action.failed', { op: valid.op, category: classified.category });
    throw error;
  } finally {
    try {
      persistTrace(traceCtx.finalize());
    } catch (_) {
      // Trace persistence is best-effort and must not change the action result.
    }
  }
}
