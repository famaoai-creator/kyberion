import { classifyError } from './error-classifier.js';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { resolveServiceBinding } from './service-binding.js';
import { safeReadFile } from './secure-io.js';
import { secretGuard } from './secret-guard.js';
import { transform } from './transformer.js';

export type RetryPolicy = {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
};

export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export { isPlainObject };

export function loadConnectionWithFallback(serviceId: string): Record<string, any> {
  const connectionPath = customerResolver.resolveOverlay(`connections/${serviceId}.json`);
  if (connectionPath) {
    try {
      const primary = JSON.parse(safeReadFile(connectionPath, { encoding: 'utf8' }) as string);
      if (primary && typeof primary === 'object' && Object.keys(primary).length > 0) return primary;
    } catch (_) {}
  }
  try {
    const fallbackPath = pathResolver.resolve(`knowledge/personal/connections/${serviceId}.json`);
    return JSON.parse(safeReadFile(fallbackPath, { encoding: 'utf8' }) as string);
  } catch (_) {
    const primary = secretGuard.loadConnectionDocument(serviceId);
    if (primary && typeof primary === 'object' && Object.keys(primary).length > 0) return primary;
    return {};
  }
}

function isUnresolvedTemplateString(value: unknown): value is string {
  return typeof value === 'string' && /^\{\{\s*[^}]+\s*\}\}$/.test(value.trim());
}

export function mergeParamsWithConnection(connection: Record<string, any>, params: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...connection };
  for (const [key, value] of Object.entries(params || {})) {
    if (isUnresolvedTemplateString(value) && merged[key] !== undefined) continue;
    merged[key] = value;
  }
  return merged;
}

export function resolveVars(input: string | undefined, vars: Record<string, any>): string {
  if (!input) return '';
  return input.replace(/{{(.*?)}}/g, (_, key) => {
    const value = vars[key.trim()];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

export function resolveTemplateValue(input: any, vars: Record<string, any>): any {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const wholeVarMatch = trimmed.match(/^{{\s*([^}]+)\s*}}$/);
    if (wholeVarMatch) {
      const value = vars[wholeVarMatch[1].trim()];
      return value !== undefined ? value : input;
    }
    return resolveVars(input, vars);
  }
  if (Array.isArray(input)) {
    return input.map((item) => resolveTemplateValue(item, vars));
  }
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, resolveTemplateValue(value, vars)]),
    );
  }
  return input;
}

export function normalizePresetResult(output: any, outputMapping?: Record<string, string>): any {
  if (!outputMapping || Object.keys(outputMapping).length === 0) return output;
  return transform(output, { type: 'json_map', mapping: outputMapping });
}

function resolveRecoveryPolicy(source: Record<string, any> | undefined): Record<string, any> {
  return isPlainObject(source?.recovery_policy) ? source.recovery_policy : {};
}

function resolveRetryPolicy(...sources: Array<Record<string, any> | undefined>): RetryPolicy {
  const merged: RetryPolicy = {};
  for (const source of sources) {
    const policy = resolveRecoveryPolicy(source);
    const retry = policy.retry || policy.default_retry || source?.retry_policy || source?.retry || {};
    if (isPlainObject(retry)) {
      Object.assign(merged, retry);
    }
  }
  return merged;
}

export function buildRetryOptions(
  serviceConfig: Record<string, any>,
  preset: Record<string, any>,
  operation: Record<string, any>,
): Required<RetryPolicy> & { shouldRetry: (error: Error) => boolean } {
  const retryableCategories = new Set<string>();
  for (const source of [serviceConfig, preset, operation]) {
    const policy = resolveRecoveryPolicy(source);
    const categories = Array.isArray(policy.retryable_categories) ? policy.retryable_categories : [];
    for (const category of categories) retryableCategories.add(String(category));
  }

  const resolvedRetry = {
    ...DEFAULT_RETRY_POLICY,
    ...resolveRetryPolicy(serviceConfig, preset, operation),
  };

  const shouldRetry = (error: Error) => {
    const classification = classifyError(error);
    if (retryableCategories.size > 0) {
      return retryableCategories.has(classification.category);
    }
    return (
      classification.category === 'network' ||
      classification.category === 'rate_limit' ||
      classification.category === 'timeout' ||
      classification.category === 'resource_unavailable'
    );
  };

  return { ...resolvedRetry, shouldRetry };
}

export function resolveRequestEnvelope(params: any): {
  templateVars: Record<string, any>;
  query?: Record<string, any>;
  body?: any;
  hasBody: boolean;
} {
  const templateVars: Record<string, any> = isPlainObject(params) ? { ...params } : {};
  let query: Record<string, any> | undefined;
  let body: any;
  let hasBody = false;

  if (isPlainObject(templateVars.vars)) {
    Object.assign(templateVars, templateVars.vars);
  }
  if (isPlainObject(templateVars.query)) {
    query = { ...templateVars.query };
  }
  if (Object.prototype.hasOwnProperty.call(templateVars, 'body')) {
    body = templateVars.body;
    hasBody = true;
  }

  return { templateVars, query, body, hasBody };
}

export function buildApiKeyQueryAuth(
  authStrategy: string | undefined,
  authParams: Record<string, any> | undefined,
  binding: ReturnType<typeof resolveServiceBinding>,
  templateVars: Record<string, any>,
): Record<string, string> {
  if (!authStrategy || authStrategy.toLowerCase() !== 'api_key_query') return {};

  const key = String(authParams?.key || 'apiKey').trim();
  if (!key) {
    throw new Error(`api_key_query auth requires a query key for service "${binding.serviceId}"`);
  }

  const resolvedValue = resolveTemplateValue(authParams?.value ?? '{{accessToken}}', {
    ...templateVars,
    ...binding,
  });
  const value = typeof resolvedValue === 'string' ? resolvedValue : String(resolvedValue ?? '');
  if (!value) {
    throw new Error(`api_key_query auth requires an access token for service "${binding.serviceId}"`);
  }

  return { [key]: value };
}

export function buildAuthHeaders(
  authStrategy: string | undefined,
  binding: ReturnType<typeof resolveServiceBinding>,
): Record<string, string> {
  if (!authStrategy || authStrategy.toLowerCase() === 'none') return {};

  if (authStrategy.toLowerCase() === 'bearer') {
    if (!binding.accessToken) {
      throw new Error(`Bearer auth requires an access token for service "${binding.serviceId}"`);
    }
    return { Authorization: `Bearer ${binding.accessToken}` };
  }

  if (authStrategy.toLowerCase() === 'basic') {
    if (binding.clientId && binding.clientSecret) {
      const credentials = Buffer.from(`${binding.clientId}:${binding.clientSecret}`, 'utf8').toString('base64');
      return { Authorization: `Basic ${credentials}` };
    }
    if (binding.accessToken) {
      return { Authorization: `Basic ${binding.accessToken}` };
    }
    throw new Error(`Basic auth requires client credentials or a pre-encoded token for service "${binding.serviceId}"`);
  }

  return {};
}

export function encodeFormBody(payload: Record<string, any>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(key, String(item));
      continue;
    }
    searchParams.append(key, String(value));
  }
  return searchParams.toString();
}

export function stripUnresolvedTemplateValues(input: any): any {
  if (typeof input === 'string') {
    return /^\{\{\s*[^}]+\s*\}\}$/.test(input.trim()) ? undefined : input;
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => stripUnresolvedTemplateValues(item))
      .filter((item) => item !== undefined);
  }
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input)
        .map(([key, value]) => [key, stripUnresolvedTemplateValues(value)])
        .filter(([, value]) => value !== undefined),
    );
  }
  return input;
}

export function prepareRequestBody(payload: any, headers: Record<string, any>): any {
  const normalizedPayload = stripUnresolvedTemplateValues(payload);
  const contentType = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded') && normalizedPayload && typeof normalizedPayload === 'object' && !Array.isArray(normalizedPayload)) {
    return encodeFormBody(normalizedPayload);
  }
  return normalizedPayload;
}

export function isCliAllowedForOperation(
  serviceConfig: Record<string, any>,
  preset: Record<string, any>,
  operation: Record<string, any>,
): boolean {
  if (process.env.KYBERION_ALLOW_UNSAFE_CLI === 'true') return true;
  return (
    Boolean(operation.allow_unsafe_cli) ||
    Boolean(preset.allow_unsafe_cli) ||
    Boolean(serviceConfig.allow_unsafe_cli)
  );
}
