import { withRetry } from './pipeline/retry-utils.js';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';

interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  onRetry?: (error: Error, attempt: number) => void;
  shouldRetry?: (error: Error) => boolean;
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  return withRetry(fn, options);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ActuatorRetryDefaults {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: boolean;
}

export interface ActuatorRetryProfile {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  retryable_categories?: string[];
}

interface RetryPolicyFile {
  version: string;
  defaults: ActuatorRetryProfile;
  actuators?: Record<string, ActuatorRetryProfile>;
}

const RETRY_POLICY_PATH = pathResolver.knowledge('product/governance/retry-policy.json');
const RETRY_POLICY_SCHEMA_PATH = pathResolver.knowledge('product/schemas/retry-policy.schema.json');

const BUILTIN_RETRY_DEFAULTS: Required<
  Pick<ActuatorRetryProfile, 'maxRetries' | 'initialDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'>
> = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

const BUILTIN_PROCESS_RETRY_OVERRIDE: Partial<ActuatorRetryProfile> = {
  initialDelayMs: 250,
  maxDelayMs: 2000,
};

const retryPolicyCatalog = defineCatalog<RetryPolicyFile>({
  id: 'retry-policy',
  path: RETRY_POLICY_PATH,
  schema: RETRY_POLICY_SCHEMA_PATH,
  fallback: {
    version: '1.0.0',
    defaults: { ...BUILTIN_RETRY_DEFAULTS },
    actuators: {
      browser: { ...BUILTIN_RETRY_DEFAULTS },
      presence: { ...BUILTIN_RETRY_DEFAULTS },
      process: { ...BUILTIN_RETRY_DEFAULTS, ...BUILTIN_PROCESS_RETRY_OVERRIDE },
      meeting: { ...BUILTIN_RETRY_DEFAULTS },
      calendar: { ...BUILTIN_RETRY_DEFAULTS },
    },
  },
});

export function loadRetryPolicy(): RetryPolicyFile {
  return retryPolicyCatalog.load();
}

/**
 * Thin policy accessor for actuator retry defaults.
 * Canonical values live in knowledge/product/governance/retry-policy.json;
 * the builtin fallback preserves historical numbers when the catalog is absent.
 */
export function getRetryDefaults(actuatorId?: string): ActuatorRetryDefaults {
  const policy = loadRetryPolicy();
  const override = (actuatorId && policy.actuators?.[actuatorId]) || {};
  const { retryable_categories: _ignored, ...resolved } = {
    ...BUILTIN_RETRY_DEFAULTS,
    ...policy.defaults,
    ...override,
  };
  void _ignored;
  return resolved;
}

export function getRetryableCategories(actuatorId?: string): string[] {
  const policy = loadRetryPolicy();
  const fromActuator = actuatorId
    ? policy.actuators?.[actuatorId]?.retryable_categories
    : undefined;
  const fromDefaults = policy.defaults?.retryable_categories;
  return [...(fromActuator || fromDefaults || [])];
}

export interface WaitForOptions {
  pollMs?: number;
  timeoutMs?: number;
  timeoutMessage?: string;
}

/**
 * Shared polling primitive consolidating the ad hoc wait loops previously
 * duplicated in browser-runtime-helpers (waitForCdpEndpoint /
 * waitForOperatorContinue). Behavior: poll until predicate is true, throw on
 * timeout, run forever when timeoutMs is undefined.
 */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  options: WaitForOptions = {}
): Promise<void> {
  const pollMs = options.pollMs ?? 100;
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      throw new Error(options.timeoutMessage || 'Timed out waiting for condition');
    }
    await sleep(pollMs);
  }
}

/**
 * Shared value-polling primitive for wait loops that must return a payload
 * (e.g. CDP endpoint discovery). Returns null on timeout instead of throwing.
 */
export async function pollForValue<T>(
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  options: WaitForOptions = {}
): Promise<T | null> {
  const pollMs = options.pollMs ?? 100;
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      return null;
    }
    await sleep(pollMs);
  }
}
