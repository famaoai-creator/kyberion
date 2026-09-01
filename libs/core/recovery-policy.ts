import { classifyError } from './error-classifier.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import type { RetryOptions } from './src/retry-utils.js';

export type RecoveryPolicy = Record<string, any>;

interface RecoveryManifest {
  recovery_policy?: unknown;
}

export interface GovernedRetryOptionsInput {
  manifestPath: string;
  defaults: RetryOptions;
  override?: Record<string, any>;
  fallbackCategories?: readonly string[];
  retryKeys?: readonly string[];
  additionalShouldRetry?: (error: Error, category: string) => boolean;
}

export type GovernedRetryOptionsBuilderInput = Omit<GovernedRetryOptionsInput, 'override'>;

const DEFAULT_RETRY_KEYS = ['retry', 'default_retry'] as const;
const DEFAULT_FALLBACK_CATEGORIES = [
  'network',
  'rate_limit',
  'timeout',
  'resource_unavailable',
] as const;

const ACTUATOR_MANIFEST_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/actuator-manifest.schema.json'
);
const manifestCatalogs = new Map<string, GovernedCatalog<RecoveryManifest>>();

function getManifestCatalog(manifestPath: string): GovernedCatalog<RecoveryManifest> {
  const existing = manifestCatalogs.get(manifestPath);
  if (existing) return existing;

  const catalog = defineCatalog<RecoveryManifest>({
    id: 'actuator-manifest-recovery-policy',
    path: manifestPath,
    schema: ACTUATOR_MANIFEST_SCHEMA_PATH,
    fallback: {},
  });
  manifestCatalogs.set(manifestPath, catalog);
  return catalog;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Load only the recovery_policy envelope from an actuator manifest. */
export function loadRecoveryPolicy(manifestPath: string): RecoveryPolicy {
  try {
    const manifest = getManifestCatalog(manifestPath).load();
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

/** Create the small actuator-local adapter without duplicating policy wiring. */
export function createGovernedRetryOptionsBuilder(
  input: GovernedRetryOptionsBuilderInput
): (override?: Record<string, unknown>) => RetryOptions {
  return (override) => buildGovernedRetryOptions({ ...input, override });
}
