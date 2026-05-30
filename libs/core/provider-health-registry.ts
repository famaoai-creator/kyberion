import {
  resolveCapabilityTarget,
  type CapabilityResolution,
  type CapabilityResolveOptions,
} from './agent-provider-resolution.js';
import { discoverProviders, type ProviderInfo } from './provider-discovery.js';

/**
 * Provider Health Registry v1.0
 *
 * Tracks *transient* provider/instance demotions (rate limits, quota exhaustion, flaky errors)
 * so the broker can fail over to a healthy target and recover automatically when the demotion
 * expires. This is the runtime piece that makes "switch when rate-limited" transparent.
 *
 * Instance dimension
 * ------------------
 * A single provider can run as several instances — e.g. two `codex` logins each with its own
 * quota ("codex x2 at home"). Instances are configured via env, e.g.:
 *
 *     KYBERION_CODEX_INSTANCES="work,personal"
 *
 * A 429 demotes a single instance (`codex#work`), not the whole provider. Failover prefers a
 * healthy instance of the *same* provider (same result characteristics) before escalating to a
 * different provider. A provider is only excluded from capability resolution once *every* one of
 * its instances is demoted.
 *
 * State is in-memory and per-process by design: demotions are short-lived and should not survive
 * a restart. Functions accept an optional `now` for deterministic testing.
 */

export interface Demotion {
  provider: string;
  instance: string;
  until: number;
  reason: string;
}

const DEFAULT_DEMOTION_MS = 60_000;
const DEFAULT_INSTANCE = 'default';

const demotions = new Map<string, Demotion>();

function keyFor(provider: string, instance: string): string {
  return `${provider}#${instance}`;
}

/**
 * Instances configured for a provider. Reads `KYBERION_<PROVIDER>_INSTANCES` (comma-separated);
 * defaults to a single implicit instance when unset.
 */
export function instancesForProvider(provider: string): string[] {
  const envKey = `KYBERION_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_INSTANCES`;
  const configured = (process.env[envKey] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : [DEFAULT_INSTANCE];
}

/**
 * Demote a provider instance for a TTL (defaults to retryAfterMs, else 60s).
 */
export function reportProviderRateLimited(
  provider: string,
  opts: { instance?: string; retryAfterMs?: number; reason?: string; now?: number } = {},
): void {
  const instance = opts.instance || DEFAULT_INSTANCE;
  const now = opts.now ?? Date.now();
  const ttl = opts.retryAfterMs && opts.retryAfterMs > 0 ? opts.retryAfterMs : DEFAULT_DEMOTION_MS;
  demotions.set(keyFor(provider, instance), {
    provider,
    instance,
    until: now + ttl,
    reason: opts.reason || 'rate_limited',
  });
}

/**
 * Clear a demotion early (e.g. after a successful call).
 */
export function reportProviderHealthy(provider: string, instance: string = DEFAULT_INSTANCE): void {
  demotions.delete(keyFor(provider, instance));
}

export function isInstanceDemoted(provider: string, instance: string = DEFAULT_INSTANCE, now: number = Date.now()): boolean {
  const entry = demotions.get(keyFor(provider, instance));
  if (!entry) return false;
  if (entry.until <= now) {
    demotions.delete(keyFor(provider, instance));
    return false;
  }
  return true;
}

/**
 * Healthy (non-demoted) instances of a provider, in configured order.
 */
export function healthyInstances(provider: string, now: number = Date.now()): string[] {
  return instancesForProvider(provider).filter((instance) => !isInstanceDemoted(provider, instance, now));
}

/**
 * Pick a healthy instance for a provider, or null when the whole pool is demoted.
 */
export function selectHealthyInstance(provider: string, now: number = Date.now()): string | null {
  return healthyInstances(provider, now)[0] ?? null;
}

/**
 * Providers whose *every* instance is currently demoted — these should be excluded from resolution.
 */
export function listDemotedProviders(providers: ProviderInfo[] = discoverProviders(), now: number = Date.now()): string[] {
  return providers
    .filter((entry) => entry.installed)
    .filter((entry) => healthyInstances(entry.provider, now).length === 0)
    .map((entry) => entry.provider);
}

/**
 * Reset all health state. Intended for tests and process re-init.
 */
export function clearProviderHealth(): void {
  demotions.clear();
}

export interface HealthAwareResolution extends CapabilityResolution {
  /** Chosen instance of the resolved provider, or null if its pool is fully demoted. */
  instance: string | null;
}

/**
 * Capability resolution that is aware of transient health: fully-demoted providers are excluded,
 * and the resolved provider is paired with one of its healthy instances.
 */
export function resolveCapabilityTargetWithHealth(
  options: CapabilityResolveOptions,
  discoveredProviders: ProviderInfo[] = discoverProviders(),
  now: number = Date.now(),
): HealthAwareResolution {
  const demotedProviders = listDemotedProviders(discoveredProviders, now);
  const resolution = resolveCapabilityTarget(
    {
      ...options,
      excludeProviders: Array.from(new Set([...(options.excludeProviders || []), ...demotedProviders])),
    },
    discoveredProviders,
  );
  return {
    ...resolution,
    instance: selectHealthyInstance(resolution.provider, now),
  };
}
