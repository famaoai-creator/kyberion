import * as path from 'node:path';
import {
  resolveCapabilityTarget,
  type CapabilityResolution,
  type CapabilityResolveOptions,
} from './agent-provider-resolution.js';
import { discoverProviders, type ProviderInfo } from './provider-discovery.js';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

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
 * Persistence (OP-04 Task 3)
 * --------------------------
 * Demotion state is mirrored to a small JSON file under the runtime root so
 * failover history survives the restarts that are unavoidable in 30-day
 * operation. Entries carry an absolute `until` timestamp, so expired
 * demotions recover naturally on load. Persistence is best-effort: a broken
 * state file never blocks the in-memory registry. Functions accept an
 * optional `now` for deterministic testing.
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

const STATE_PATH_ENV = 'KYBERION_PROVIDER_HEALTH_STATE_PATH';
let loadedFromPath: string | null = null;

// Under vitest, disable persistence unless a test opts in with an explicit
// state path: worker processes would otherwise share the real state file and
// leak demotions across unrelated test files (same pattern as
// operator-notifications' VITEST guard).
function persistenceEnabled(): boolean {
  return !process.env.VITEST || Boolean(process.env[STATE_PATH_ENV]);
}

function stateFilePath(): string {
  const override = process.env[STATE_PATH_ENV];
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.active('shared/runtime/provider-health.json');
}

function ensureLoaded(now: number = Date.now()): void {
  if (!persistenceEnabled()) return;
  const filePath = stateFilePath();
  if (loadedFromPath === filePath) return;
  loadedFromPath = filePath;
  demotions.clear();
  if (!safeExistsSync(filePath)) return;
  try {
    const parsed = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }) || '{}')) as {
      demotions?: Demotion[];
    };
    for (const entry of parsed.demotions || []) {
      if (!entry?.provider || !entry.instance || !Number.isFinite(entry.until)) continue;
      if (entry.until <= now) continue; // TTL recovery across restarts
      demotions.set(keyFor(entry.provider, entry.instance), entry);
    }
  } catch (err) {
    logger.warn(`[provider-health] failed to load persisted state, starting empty: ${err}`);
  }
}

function persist(): void {
  if (!persistenceEnabled()) return;
  const filePath = stateFilePath();
  try {
    safeMkdir(path.dirname(filePath), { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({ version: '1.0', demotions: [...demotions.values()] }, null, 2)
    );
  } catch (err) {
    // Best-effort: in-memory failover keeps working even if persistence fails.
    logger.warn(`[provider-health] failed to persist state: ${err}`);
  }
}

/**
 * Drop the in-memory view and reload from the persisted state file. Simulates
 * a process restart; also useful after external edits to the state file.
 */
export function reloadProviderHealthFromDisk(now: number = Date.now()): void {
  loadedFromPath = null;
  ensureLoaded(now);
}

export function getProviderHealthDemotionTtlMs(): number {
  const configured = Number(process.env.KYBERION_PROVIDER_DEMOTION_TTL_MS || '');
  if (Number.isFinite(configured) && configured > 0) {
    return Math.round(configured);
  }
  return DEFAULT_DEMOTION_MS;
}

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
  opts: { instance?: string; retryAfterMs?: number; reason?: string; now?: number } = {}
): void {
  reportProviderTemporarilyUnhealthy(provider, {
    instance: opts.instance,
    retryAfterMs: opts.retryAfterMs,
    reason: opts.reason || 'rate_limited',
    now: opts.now,
  });
}

/**
 * Temporarily demote a provider instance for a TTL.
 *
 * Use this for any short-lived failure mode that should trigger a retry on the
 * next healthy candidate. `reportProviderRateLimited()` is a semantic wrapper.
 */
export function reportProviderTemporarilyUnhealthy(
  provider: string,
  opts: { instance?: string; retryAfterMs?: number; reason?: string; now?: number } = {}
): void {
  const instance = opts.instance || DEFAULT_INSTANCE;
  const now = opts.now ?? Date.now();
  ensureLoaded(now);
  const ttl =
    opts.retryAfterMs && opts.retryAfterMs > 0
      ? opts.retryAfterMs
      : getProviderHealthDemotionTtlMs();
  demotions.set(keyFor(provider, instance), {
    provider,
    instance,
    until: now + ttl,
    reason: opts.reason || 'temporarily_unhealthy',
  });
  persist();
}

/**
 * Clear a demotion early (e.g. after a successful call).
 */
export function reportProviderHealthy(provider: string, instance: string = DEFAULT_INSTANCE): void {
  ensureLoaded();
  if (demotions.delete(keyFor(provider, instance))) {
    persist();
  }
}

export function isInstanceDemoted(
  provider: string,
  instance: string = DEFAULT_INSTANCE,
  now: number = Date.now()
): boolean {
  ensureLoaded(now);
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
  return instancesForProvider(provider).filter(
    (instance) => !isInstanceDemoted(provider, instance, now)
  );
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
export function listDemotedProviders(
  providers: ProviderInfo[] = discoverProviders(),
  now: number = Date.now()
): string[] {
  return providers
    .filter((entry) => entry.installed)
    .filter((entry) => healthyInstances(entry.provider, now).length === 0)
    .map((entry) => entry.provider);
}

/**
 * Reset all health state, including the persisted file. Intended for tests
 * and process re-init.
 */
export function clearProviderHealth(): void {
  demotions.clear();
  if (!persistenceEnabled()) return;
  loadedFromPath = stateFilePath();
  try {
    if (safeExistsSync(stateFilePath())) safeRmSync(stateFilePath());
  } catch (err) {
    logger.warn(`[provider-health] failed to remove persisted state: ${err}`);
  }
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
  now: number = Date.now()
): HealthAwareResolution {
  const demotedProviders = listDemotedProviders(discoveredProviders, now);
  const resolution = resolveCapabilityTarget(
    {
      ...options,
      excludeProviders: Array.from(
        new Set([...(options.excludeProviders || []), ...demotedProviders])
      ),
    },
    discoveredProviders
  );
  return {
    ...resolution,
    instance: selectHealthyInstance(resolution.provider, now),
  };
}
