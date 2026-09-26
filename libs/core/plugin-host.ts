/**
 * PH-01: in-process plugin host for long-running surfaces (Chronos, pads).
 *
 * A host keeps the process's plugin activations (`plugin-lifecycle.ts`) in
 * line with the managed install directory: every sync lists the managed
 * records and
 *
 *   - activates eligible records that are not active yet;
 *   - reloads an active plugin whose approved content or grant digest changed;
 *   - deactivates plugins it activated whose record disappeared, is no longer
 *     activatable (pending approval, tampered, broken) or is out of scope.
 *
 * Eligible = `activatable` and either tenant-less (shared) or bound to a tenant
 * in `tenantAllow`. Records of other tenants are dropped by the listing itself
 * after parsing their record file — the host never activates, digests or
 * imports them, and activation re-verifies only the target copy by id — and
 * refuses before import when the re-read record's tenant or digests no longer
 * match the listed one. Operations are registered process-wide, so the tenant
 * allowlist is the isolation boundary: allowing several tenants in one host
 * merges their trust (see plugin-permissions-and-views.md).
 *
 * Syncs are single-flight: requests while a sync runs coalesce into exactly
 * one follow-up sync. A per-record fingerprint (id, status, both digests,
 * tenant) gates lifecycle calls, so polling an unchanged directory is cheap
 * and never re-imports a module; a failed activation is retried only once the
 * record changes. Import failures are recorded as `refused` — they never
 * throw out of `syncNow` or the poll timer. Every activate / deactivate /
 * refuse transition is audited. `status()` carries codes and digest prefixes
 * only (never managed paths or error text).
 *
 * Reloads retain the previous module in memory (see plugin-lifecycle.ts).
 */
import { auditChain, type AuditEntry } from './audit-chain.js';
import { isReservedScopeName, isValidTenantSlug } from './foundation/scope.js';
import {
  activatePlugin,
  deactivatePlugin,
  getActivePluginContentDigest,
  getActivePluginPermissionsDigest,
  isPluginActive,
  reloadPlugin,
  type ManagedPluginExpectation,
} from './plugin-lifecycle.js';
import {
  isManagedPluginActivationAllowed,
  listManagedPlugins,
  type ManagedPluginRecord,
  type ManagedPluginRecordHeader,
} from './plugin-managed-install.js';
import { resolveTenant } from './tenant-registry.js';

export type PluginHostPluginState = 'active' | 'inactive' | 'refused' | 'restart_required';

export type PluginHostReasonCode =
  | 'activated'
  | 'reloaded'
  | 'unchanged'
  | 'pending_approval'
  | 'blocked_broken_manifest'
  | 'blocked_digest_mismatch'
  | 'activation_failed'
  | 'reload_failed'
  | 'reload_kept_previous'
  | 'restart_required';

export interface PluginHostPluginStatus {
  pluginId: string;
  state: PluginHostPluginState;
  /** First 12 hex chars of the approved content digest (absent on legacy records). */
  contentDigestPrefix?: string;
  reasonCode: PluginHostReasonCode;
}

export interface PluginHostStatus {
  enabled: boolean;
  surface: string;
  lastSyncAt?: string;
  /** Set when the last listing failed; every host activation was then deactivated. */
  lastSyncErrorCode?: 'listing_failed';
  plugins: PluginHostPluginStatus[];
}

export interface PluginHostTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type PluginHostAuditAction =
  'plugin_host.activate' | 'plugin_host.deactivate' | 'plugin_host.refuse';

export type PluginHostAuditEntry = Omit<
  AuditEntry,
  'id' | 'timestamp' | 'previousHash' | 'currentHash'
> & { action: PluginHostAuditAction };

export interface CreatePluginHostOptions {
  /** Surface id (audit agent id + status). */
  surface: string;
  /** false = every method is a no-op and status reports enabled:false. Default true. */
  enabled?: boolean;
  /** Managed-plugins root override (tests). */
  managedRoot?: string;
  /** Tenants whose tenant-bound plugins may run here; tenant-less plugins always may. */
  tenantAllow: readonly string[];
  /** Poll interval; default 30s, minimum 1s. */
  pollMs?: number;
  listRecords?: () => ManagedPluginRecord[];
  timers?: PluginHostTimers;
  now?: () => Date;
  audit?: (entry: PluginHostAuditEntry) => void;
}

export interface PluginHost {
  readonly surface: string;
  start(): void;
  stop(): void;
  syncNow(): Promise<PluginHostStatus>;
  status(): PluginHostStatus;
}

export const DEFAULT_PLUGIN_HOST_POLL_MS = 30_000;
const MIN_PLUGIN_HOST_POLL_MS = 1_000;

/** Parses a poll interval setting; invalid / missing values fall back to the default. */
export function resolvePluginHostPollMs(raw: string | number | undefined): number {
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw?.trim() ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PLUGIN_HOST_POLL_MS;
  return Math.max(MIN_PLUGIN_HOST_POLL_MS, Math.floor(value));
}

/**
 * Parses a comma-separated tenant allowlist. Each entry must be a valid,
 * non-reserved tenant slug that `isKnownTenant` accepts (default: resolves in
 * the tenant registry); everything else is returned in `rejected` and never
 * allowed. Unset / empty => no tenant (only tenant-less shared plugins run).
 */
export function parsePluginHostTenantAllow(
  raw: string | undefined,
  isKnownTenant: (slug: string) => boolean = defaultIsKnownTenant
): { tenants: string[]; rejected: string[] } {
  const tenants: string[] = [];
  const rejected: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const slug = entry.trim();
    if (!slug) continue;
    const valid = !isReservedScopeName(slug) && isValidTenantSlug(slug) && isKnownTenant(slug);
    if (!valid) rejected.push(slug);
    else if (!tenants.includes(slug)) tenants.push(slug);
  }
  return { tenants, rejected };
}

function defaultIsKnownTenant(slug: string): boolean {
  try {
    resolveTenant(slug);
    return true;
  } catch {
    return false;
  }
}

const defaultTimers: PluginHostTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

interface TrackedPlugin {
  fingerprint: string;
  status: PluginHostPluginStatus;
}

function fingerprintOf(record: ManagedPluginRecord): string {
  return JSON.stringify([
    record.pluginId,
    record.activationStatus,
    record.contentDigest ?? '',
    record.permissionsDigest ?? '',
    record.tenantSlug ?? '',
  ]);
}

function expectationOf(record: ManagedPluginRecord): ManagedPluginExpectation {
  return {
    tenantSlug: record.tenantSlug ?? null,
    contentDigest: record.contentDigest,
    permissionsDigest: record.permissionsDigest,
  };
}

function digestPrefix(record: ManagedPluginRecord): { contentDigestPrefix?: string } {
  return record.contentDigest ? { contentDigestPrefix: record.contentDigest.slice(0, 12) } : {};
}

export function createPluginHost(options: CreatePluginHostOptions): PluginHost {
  const surface = options.surface;
  const enabled = options.enabled !== false;
  const tenantAllow = new Set(options.tenantAllow);
  const pollMs = resolvePluginHostPollMs(options.pollMs);
  const timers = options.timers ?? defaultTimers;
  const now = options.now ?? (() => new Date());
  // Headers of other tenants' records dropped by the last default listing.
  let excluded: ManagedPluginRecordHeader[] = [];
  const listRecords =
    options.listRecords ??
    (() =>
      listManagedPlugins(options.managedRoot, {
        tenantAllow: [...tenantAllow],
        onExcluded: (header) => excluded.push(header),
      }));
  const lifecycleOptions = { managedRoot: options.managedRoot };
  const audit = options.audit ?? ((entry: PluginHostAuditEntry) => void auditChain.record(entry));

  const tracked = new Map<string, TrackedPlugin>();
  let lastSyncAt: string | undefined;
  let lastSyncErrorCode: PluginHostStatus['lastSyncErrorCode'];
  let pollHandle: unknown;
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  function record(
    action: PluginHostAuditAction,
    pluginId: string,
    result: AuditEntry['result'],
    reasonCode: string,
    extra: { tenantSlug?: string; contentDigestPrefix?: string } = {}
  ): void {
    try {
      audit({
        agentId: `plugin-host:${surface}`,
        action,
        operation: pluginId,
        result,
        reason: reasonCode,
        metadata: {
          surface,
          plugin_id: pluginId,
          reason_code: reasonCode,
          ...(extra.contentDigestPrefix
            ? { content_digest_prefix: extra.contentDigestPrefix }
            : {}),
        },
        ...(extra.tenantSlug ? { tenantSlug: extra.tenantSlug } : {}),
      });
    } catch {
      // Auditing must never take the host (or the surface) down.
    }
  }

  /** Fail closed: a plugin that may not run here is stopped whoever started it. */
  function release(pluginId: string, reasonCode: string, tenantSlug?: string): void {
    if (!isPluginActive(pluginId)) return;
    try {
      deactivatePlugin(pluginId);
    } catch {
      // deactivatePlugin disposes best effort; the activation is gone either way.
    }
    record('plugin_host.deactivate', pluginId, 'completed', reasonCode, { tenantSlug });
  }

  function isEligibleScope(entry: ManagedPluginRecord): boolean {
    return !entry.tenantSlug || tenantAllow.has(entry.tenantSlug);
  }

  async function applyRecord(entry: ManagedPluginRecord, previous?: TrackedPlugin) {
    const pluginId = entry.pluginId;
    const fingerprint = fingerprintOf(entry);
    const base = { pluginId, ...digestPrefix(entry) };
    const audited = { tenantSlug: entry.tenantSlug, ...digestPrefix(entry) };
    const next: TrackedPlugin = {
      fingerprint,
      status: previous?.status ?? { ...base, state: 'inactive', reasonCode: 'unchanged' },
    };
    tracked.set(pluginId, next);

    if (!isManagedPluginActivationAllowed(entry)) {
      const reasonCode = entry.activationStatus as PluginHostReasonCode;
      release(pluginId, reasonCode, entry.tenantSlug);
      if (previous?.fingerprint !== fingerprint) {
        record('plugin_host.refuse', pluginId, 'denied', reasonCode, audited);
      }
      next.status = { ...base, state: 'inactive', reasonCode };
      return;
    }

    const active = isPluginActive(pluginId);
    // Unchanged record and unchanged liveness: nothing to do (a failed
    // activation is retried only once the record changes).
    const state = previous?.status.state;
    const settled = active
      ? state === 'active' || state === 'restart_required'
      : state !== 'active';
    if (previous?.fingerprint === fingerprint && settled) return;

    if (!active) {
      try {
        const result = await activatePlugin(
          { record: entry, expected: expectationOf(entry) },
          lifecycleOptions
        );
        if (!result.ok) throw new Error(result.reason);
        next.status = { ...base, state: 'active', reasonCode: 'activated' };
        record('plugin_host.activate', pluginId, 'completed', 'activated', audited);
      } catch {
        next.status = { ...base, state: 'refused', reasonCode: 'activation_failed' };
        record('plugin_host.refuse', pluginId, 'failed', 'activation_failed', audited);
      }
      return;
    }

    const unchanged =
      getActivePluginContentDigest(pluginId) === entry.contentDigest &&
      (getActivePluginPermissionsDigest(pluginId) ?? undefined) === entry.permissionsDigest;
    if (unchanged) {
      next.status = { ...base, state: 'active', reasonCode: 'unchanged' };
      return;
    }
    let result: Awaited<ReturnType<typeof reloadPlugin>> | undefined;
    try {
      result = await reloadPlugin(pluginId, {
        ...lifecycleOptions,
        source: { record: entry, expected: expectationOf(entry) },
      });
    } catch {
      result = undefined;
    }
    const stillActive = isPluginActive(pluginId);
    if (result?.ok) {
      next.status = { ...base, state: 'active', reasonCode: 'reloaded' };
      record('plugin_host.activate', pluginId, 'completed', 'reloaded', audited);
    } else if (result?.mode === 'restart_required') {
      next.status = { ...base, state: 'restart_required', reasonCode: 'restart_required' };
      record(
        stillActive ? 'plugin_host.refuse' : 'plugin_host.deactivate',
        pluginId,
        'failed',
        'restart_required',
        audited
      );
    } else if (stillActive) {
      next.status = { ...base, state: 'active', reasonCode: 'reload_kept_previous' };
      record('plugin_host.refuse', pluginId, 'failed', 'reload_kept_previous', audited);
    } else {
      next.status = { ...base, state: 'refused', reasonCode: 'reload_failed' };
      record('plugin_host.deactivate', pluginId, 'failed', 'reload_failed', audited);
    }
  }

  async function runSync(): Promise<void> {
    let records: ManagedPluginRecord[];
    excluded = [];
    try {
      records = listRecords();
      lastSyncErrorCode = undefined;
    } catch {
      // Fail closed: nothing this host started keeps running unverified.
      lastSyncErrorCode = 'listing_failed';
      for (const pluginId of tracked.keys()) release(pluginId, 'listing_failed');
      tracked.clear();
      lastSyncAt = now().toISOString();
      return;
    }
    const seen = new Set<string>();
    for (const header of excluded) {
      // Another tenant: stop it if something started it.
      release(header.pluginId, 'tenant_excluded', header.tenantSlug);
    }
    for (const entry of records) {
      if (!isEligibleScope(entry)) {
        // Another tenant: never read further; stop it if something started it.
        release(entry.pluginId, 'tenant_excluded', entry.tenantSlug);
        continue;
      }
      seen.add(entry.pluginId);
      try {
        await applyRecord(entry, tracked.get(entry.pluginId));
      } catch {
        const current = tracked.get(entry.pluginId);
        if (current) {
          current.status = { ...current.status, state: 'refused', reasonCode: 'activation_failed' };
        }
      }
    }
    for (const pluginId of [...tracked.keys()]) {
      if (seen.has(pluginId)) continue;
      release(pluginId, 'removed');
      tracked.delete(pluginId);
    }
    lastSyncAt = now().toISOString();
  }

  function schedule(): Promise<void> {
    if (!inFlight) {
      inFlight = runSync()
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    }
    queued ??= inFlight.then(() => {
      queued = null;
      return schedule();
    });
    return queued;
  }

  function status(): PluginHostStatus {
    return {
      enabled,
      surface,
      ...(lastSyncAt ? { lastSyncAt } : {}),
      ...(lastSyncErrorCode ? { lastSyncErrorCode } : {}),
      plugins: [...tracked.values()]
        .map((entry) => ({ ...entry.status }))
        .sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0)),
    };
  }

  return {
    surface,
    start() {
      if (!enabled || pollHandle !== undefined) return;
      pollHandle = timers.setInterval(() => void schedule(), pollMs);
      void schedule();
    },
    stop() {
      if (pollHandle === undefined) return;
      timers.clearInterval(pollHandle);
      pollHandle = undefined;
    },
    async syncNow() {
      if (enabled) await schedule();
      return status();
    },
    status,
  };
}

function registryKey(surface: string): symbol {
  return Symbol.for(`kyberion.pluginHost.${surface}`);
}

/**
 * Returns the process-wide host of `surface`, creating it with `factory` on
 * first use. Stored on `globalThis` so dev-server module reloads (HMR) and
 * separately bundled route modules share one host per surface.
 */
export function getOrCreatePluginHost(surface: string, factory: () => PluginHost): PluginHost {
  const holder = globalThis as Record<symbol, unknown>;
  const key = registryKey(surface);
  const existing = holder[key] as PluginHost | undefined;
  if (existing) return existing;
  const host = factory();
  holder[key] = host;
  return host;
}

export function getPluginHost(surface: string): PluginHost | undefined {
  return (globalThis as Record<symbol, unknown>)[registryKey(surface)] as PluginHost | undefined;
}

/** Stops and forgets the host of `surface` (tests / shutdown). Activations are left as-is. */
export function disposePluginHost(surface: string): void {
  const holder = globalThis as Record<symbol, unknown>;
  const key = registryKey(surface);
  (holder[key] as PluginHost | undefined)?.stop();
  delete holder[key];
}
