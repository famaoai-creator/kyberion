import { classifyError } from './error-classifier.js';
import { safeReadFile } from './secure-io.js';
import type { RetryOptions } from './src/retry-utils.js';

export type RecoveryPolicy = Record<string, any>;

export interface GovernedRetryOptionsInput {
  manifestPath: string;
  defaults: RetryOptions;
  override?: Record<string, any>;
  fallbackCategories?: readonly string[];
  retryKeys?: readonly string[];
  additionalShouldRetry?: (error: Error, category: string) => boolean;
}

const DEFAULT_RETRY_KEYS = ['retry', 'default_retry'] as const;
const DEFAULT_FALLBACK_CATEGORIES = [
  'network',
  'rate_limit',
  'timeout',
  'resource_unavailable',
] as const;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Load only the recovery_policy envelope from an actuator manifest. */
export function loadRecoveryPolicy(manifestPath: string): RecoveryPolicy {
  try {
    const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string);
    return isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
  } catch {
    return {};
  }
}

/**
 * Build actuator retry options without changing actuator-specific defaults.
 * The policy order is: actuator defaults -> manifest retry policy -> explicit override.
 */
export function buildGovernedRetryOptions({
  manifestPath,
  defaults,
  override,
  fallbackCategories = DEFAULT_FALLBACK_CATEGORIES,
  retryKeys = DEFAULT_RETRY_KEYS,
  additionalShouldRetry,
}: GovernedRetryOptionsInput): RetryOptions {
  const policy = loadRecoveryPolicy(manifestPath);
  const manifestRetry = retryKeys.reduce<Record<string, any>>((resolved, key) => {
    const candidate = policy[key];
    return isPlainObject(candidate) ? { ...resolved, ...candidate } : resolved;
  }, {});
  const retryableCategories = new Set<string>(
    Array.isArray(policy.retryable_categories) ? policy.retryable_categories.map(String) : []
  );
  const resolved = {
    ...defaults,
    ...manifestRetry,
    ...(override || {}),
  };

  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const category = classifyError(error).category;
      const categoryAllowed =
        retryableCategories.size > 0
          ? retryableCategories.has(category)
          : fallbackCategories.includes(category);
      return categoryAllowed || Boolean(additionalShouldRetry?.(error, category));
    },
  };
}
