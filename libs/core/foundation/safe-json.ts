const JSON_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface SafeJsonParseOptions {
  preserveParseError?: boolean;
}

function isSafeJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSafeJsonValue);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, nested]) => !JSON_DANGEROUS_KEYS.has(key) && isSafeJsonValue(nested)
  );
}

export function parseSafeJsonInput(
  raw: string,
  label: string,
  options: SafeJsonParseOptions = {}
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (options.preserveParseError) throw error;
    throw new Error(`${label} must be valid JSON`);
  }
  if (!isSafeJsonValue(parsed)) {
    throw new Error(`${label} contains a dangerous JSON key`);
  }
  return parsed;
}

export function parseSafeJsonObjectInput(
  raw: string | undefined,
  label: string
): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return parseSafeJsonObjectValue(parseSafeJsonInput(raw, label), label);
}

export function parseSafeJsonObjectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isSafeJsonValue(value)) {
    throw new Error(`${label} contains a dangerous JSON key`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export type PersistedPipelineStep = {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: Record<string, unknown>;
};

export type PersistedPipelineStrategyConfig = {
  strategies: Array<{
    pipeline: PersistedPipelineStep[];
    params?: Record<string, unknown>;
  }>;
};

function parsePersistedPipelineStep(value: unknown, label: string): PersistedPipelineStep {
  const step = parseSafeJsonObjectValue(value, label);
  if (
    (step.type !== 'capture' &&
      step.type !== 'transform' &&
      step.type !== 'apply' &&
      step.type !== 'control') ||
    typeof step.op !== 'string' ||
    step.op.trim() === ''
  ) {
    throw new Error(`${label} must declare a valid type and non-empty op`);
  }

  const params = parseSafeJsonObjectValue(step.params, `${label}.params`);
  for (const nestedKey of ['then', 'else', 'pipeline'] as const) {
    const nested = params[nestedKey];
    if (nested === undefined) continue;
    if (!Array.isArray(nested)) {
      throw new Error(`${label}.params.${nestedKey} must be an array of pipeline steps`);
    }
    nested.forEach((candidate, index) =>
      parsePersistedPipelineStep(candidate, `${label}.params.${nestedKey}[${index}]`)
    );
  }

  return {
    type: step.type,
    op: step.op,
    params,
  };
}

/** Validate a persisted reconcile strategy before any pipeline step executes. */
export function parsePersistedPipelineStrategy(
  value: unknown,
  label = 'persisted pipeline strategy'
): PersistedPipelineStrategyConfig {
  const root = parseSafeJsonObjectValue(value, label);
  if (!Array.isArray(root.strategies)) {
    throw new Error(`${label}.strategies must be an array`);
  }

  return {
    strategies: root.strategies.map((candidate, index) => {
      const strategy = parseSafeJsonObjectValue(candidate, `${label}.strategies[${index}]`);
      if (!Array.isArray(strategy.pipeline)) {
        throw new Error(`${label}.strategies[${index}].pipeline must be an array`);
      }
      const params =
        strategy.params === undefined
          ? undefined
          : parseSafeJsonObjectValue(strategy.params, `${label}.strategies[${index}].params`);
      return {
        pipeline: strategy.pipeline.map((step, stepIndex) =>
          parsePersistedPipelineStep(step, `${label}.strategies[${index}].pipeline[${stepIndex}]`)
        ),
        ...(params ? { params } : {}),
      };
    }),
  };
}

export type JsonObjectRequest = {
  json: () => Promise<unknown>;
};

export type JsonObjectRequestResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** Read an async request body as a safe JSON object before surface route logic. */
export async function readJsonObjectRequest(
  request: JsonObjectRequest,
  label = 'request body'
): Promise<JsonObjectRequestResult> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: `${label} must be valid JSON` };
  }
  try {
    return { ok: true, body: parseSafeJsonObjectValue(raw, label) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
