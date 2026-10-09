/**
 * spend-guard.ts — OP-01: real budget control for LLM usage.
 *
 * costCapTokens was only ever injected into prompts as text; this module is
 * the actual control: cumulative cost (from the metrics usage history, which
 * already records cost_usd per call) is compared against the governed caps
 * in knowledge/product/governance/spend-policy.json before a reasoning call
 * runs. Posture 'warn' (default per the plan's risk note) alerts through the
 * AO-03 ops-alert sink and lets the call proceed; posture 'block' raises
 * SpendCapExceededError — the operator flow is "cap reached: approve to
 * continue or raise the cap".
 */

import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { isVitestProcess } from './foundation/env.js';
import {
  aggregateMetricsForEnforcement,
  onExecutionMetricsAppend,
  type ExecutionAppendNotice,
} from './metrics.js';
import type { StoragePartition } from './storage-layout.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';
import { sendOpsAlert } from './ops-alert.js';
import { pathResolver } from './path-resolver.js';

export interface SpendPolicyOverride {
  posture?: 'warn' | 'block';
  daily_cap_usd?: number;
  mission_cap_usd?: number;
}

export interface SpendPolicy {
  posture: 'warn' | 'block';
  daily_cap_usd: number;
  mission_cap_usd: number;
  /** Per-tenant cap overrides keyed by tenant id (KYBERION_TENANT). */
  tenant_overrides?: Record<string, SpendPolicyOverride>;
}

export interface SpendGuardResult {
  allowed: boolean;
  posture: SpendPolicy['posture'];
  daily_spent_usd: number;
  daily_cap_usd: number;
  mission_spent_usd?: number;
  mission_cap_usd?: number;
  breached: Array<'daily' | 'mission'>;
}

export class SpendCapExceededError extends Error {
  constructor(public readonly result: SpendGuardResult) {
    super(
      `[spend-guard] cap reached (${result.breached.join(', ')}): ` +
        `daily $${result.daily_spent_usd.toFixed(2)}/$${result.daily_cap_usd} — ` +
        'approve to continue or raise the cap in spend-policy.json'
    );
    this.name = 'SpendCapExceededError';
  }
}

const POLICY_PATH = pathResolver.knowledge('product/governance/spend-policy.json');

const spendPolicyCatalog = defineCatalog<SpendPolicy>({
  id: 'spend-policy',
  path: POLICY_PATH,
  schema: pathResolver.knowledge('product/schemas/spend-policy.schema.json'),
});

export function loadSpendPolicy(): SpendPolicy {
  const parsed = spendPolicyCatalog.load();
  const tenantOverrides: Record<string, SpendPolicyOverride> = {};
  for (const [tenant, raw] of Object.entries(parsed.tenant_overrides ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    const override: SpendPolicyOverride = {};
    if (raw.posture === 'block' || raw.posture === 'warn') override.posture = raw.posture;
    if (Number(raw.daily_cap_usd) > 0) override.daily_cap_usd = Number(raw.daily_cap_usd);
    if (Number(raw.mission_cap_usd) > 0) override.mission_cap_usd = Number(raw.mission_cap_usd);
    if (Object.keys(override).length > 0) tenantOverrides[tenant] = override;
  }
  return {
    posture: parsed.posture === 'block' ? 'block' : 'warn',
    daily_cap_usd: parsed.daily_cap_usd,
    mission_cap_usd: parsed.mission_cap_usd,
    ...(Object.keys(tenantOverrides).length > 0 ? { tenant_overrides: tenantOverrides } : {}),
  };
}

/**
 * OP-01 Task 3: tenant override. The effective policy for a tenant is the
 * base policy with that tenant's overrides applied; unknown tenants (or no
 * tenant) keep the base policy.
 */
export function resolveSpendPolicyForTenant(policy: SpendPolicy, tenantId?: string): SpendPolicy {
  const id = tenantId ?? getRegisteredEnvText('KYBERION_TENANT');
  const override = id ? policy.tenant_overrides?.[id] : undefined;
  if (!override) return policy;
  return {
    posture: override.posture ?? policy.posture,
    daily_cap_usd: override.daily_cap_usd ?? policy.daily_cap_usd,
    mission_cap_usd: override.mission_cap_usd ?? policy.mission_cap_usd,
  };
}

interface UsageEntry {
  timestamp?: string;
  cost_usd?: number;
  mission_id?: string;
}

export function sumSpend(
  entries: UsageEntry[],
  input: { sinceMs: number; missionId?: string }
): { daily: number; mission: number } {
  let daily = 0;
  let mission = 0;
  for (const entry of entries) {
    const cost = Number(entry.cost_usd);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const at = Date.parse(String(entry.timestamp || ''));
    if (!Number.isFinite(at) || at < input.sinceMs) continue;
    daily += cost;
    if (input.missionId && entry.mission_id === input.missionId) mission += cost;
  }
  return { daily, mission };
}

// Reading the metrics ledgers is file I/O; cache briefly so the guard adds
// no measurable latency to bursts of reasoning calls. An entry is keyed by the
// tenant whose ledgers were read (or '*' for the global read), the day and
// the mission. Costed rows this process appends are added to every matching
// entry at append time (onExecutionMetricsAppend), so a burst is reflected
// without a re-read; zero-cost rows change nothing, and only a costed row that
// cannot be attributed (unparseable timestamp) drops the entries it may touch.
// Other processes' spend is picked up when the TTL expires. Expired entries
// are evicted and the map is bounded.
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 64;
type SpendReadScope = { kind: 'all' } | { kind: 'tenant'; tenant: string };
interface CachedSpend {
  at: number;
  scope: SpendReadScope;
  sinceMs: number;
  missionId?: string;
  spend: { daily: number; mission: number };
}
const cachedSpend = new Map<string, CachedSpend>();
let cacheReads = 0;

/** Test hook: drop cached spend totals. */
export function resetSpendGuardCache(): void {
  cachedSpend.clear();
  cacheReads = 0;
}

/** Test hook: ledger reads the guard performed since the last reset. */
export function spendGuardLedgerReads(): number {
  return cacheReads;
}

function rememberSpend(key: string, entry: CachedSpend): void {
  for (const [cachedKey, cached] of cachedSpend) {
    if (entry.at - cached.at >= CACHE_TTL_MS) cachedSpend.delete(cachedKey);
  }
  cachedSpend.delete(key);
  while (cachedSpend.size >= CACHE_MAX_ENTRIES) {
    const oldest = cachedSpend.keys().next().value;
    if (oldest === undefined) break;
    cachedSpend.delete(oldest);
  }
  cachedSpend.set(key, entry);
}

/** Does a row in `partition` fall inside this cached read? */
function inReadScope(scope: SpendReadScope, partition: StoragePartition): boolean {
  if (scope.kind === 'all') return true;
  if (partition.kind === 'system') return true;
  return partition.tenant?.trim().toLowerCase() === scope.tenant;
}

// Subscribed on the first cached read (an empty cache needs no updates), so
// importing this module has no side effect on the metrics module.
let appendListenerInstalled = false;
function installAppendListener(): void {
  if (appendListenerInstalled) return;
  appendListenerInstalled = true;
  onExecutionMetricsAppend(applyOwnAppend);
}

function applyOwnAppend(notice: ExecutionAppendNotice): void {
  for (const [key, entry] of cachedSpend) {
    if (!inReadScope(entry.scope, notice.partition)) continue;
    if (!Number.isFinite(notice.at)) {
      // Cannot tell which day it belongs to: re-read rather than guess.
      cachedSpend.delete(key);
      continue;
    }
    if (notice.at < entry.sinceMs) continue;
    entry.spend.daily += notice.cost_usd;
    if (entry.missionId && notice.mission_id === entry.missionId) {
      entry.spend.mission += notice.cost_usd;
    }
  }
}

function normalizeTenant(value: string | undefined | null): string | undefined {
  const tenant = value?.trim().toLowerCase();
  return tenant || undefined;
}

/**
 * Today's spend through the governed enforcement aggregate, as numbers only —
 * the guard never receives ledger rows. A tenant scope reads that tenant's
 * partitions (every tier) plus the system partition; the global scope reads
 * every partition.
 */
function loadSpend(now: number, input: { sinceMs: number; missionId?: string; tenant?: string }) {
  const scope: SpendReadScope = input.tenant
    ? { kind: 'tenant', tenant: input.tenant }
    : { kind: 'all' };
  const key = `${input.tenant ?? '*'}|${input.sinceMs}|${input.missionId ?? ''}`;
  const hit = cachedSpend.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { ...hit.spend };
  cacheReads += 1;
  installAppendListener();
  const totals = aggregateMetricsForEnforcement({
    enforcer: 'spend_guard',
    ledger: 'execution_metrics',
    read: input.tenant ? { tenants: [input.tenant], includeSystem: true } : { all: true },
    measures: ['daily', 'mission'] as const,
    accumulate: (row, add) => {
      const spend = sumSpend(
        [
          {
            timestamp: row.timestamp,
            cost_usd: row.cost_usd ?? undefined,
            mission_id: row.mission_id,
          },
        ],
        input
      );
      add('daily', spend.daily);
      add('mission', spend.mission);
    },
  });
  if (totals.withheld_partitions > 0) {
    logger.warn(
      `[spend-guard] spend for ${input.tenant ?? 'the global cap'} is partial — ${totals.withheld_partitions} metrics partition(s) withheld | next: evaluate global caps from an unbound operator process | evidence: tenant ${input.tenant ?? '(unbound)'}`
    );
  }
  const spend = { daily: totals.measures.daily, mission: totals.measures.mission };
  rememberSpend(key, {
    at: now,
    scope,
    sinceMs: input.sinceMs,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    spend: { ...spend },
  });
  return spend;
}

const alertedBreaches = new Set<string>();

export function checkSpendGuard(
  options: {
    missionId?: string;
    now?: number;
    entries?: UsageEntry[];
    policy?: SpendPolicy;
    tenantId?: string;
    alert?: typeof sendOpsAlert;
  } = {}
): SpendGuardResult {
  const now = options.now ?? Date.now();
  // A tenant-bound process always evaluates its bound tenant's caps over that
  // tenant's ledgers (policy and read from the same tenant). Tenant
  // authorization is the scope layer's job, not the spend guard's: a
  // different requested tenant (e.g. a brokered mission's) is ignored, never
  // refused. An unbound process evaluates the requested tenant's caps over its
  // ledgers, or the global caps over every ledger when none is requested.
  const boundTenant = normalizeTenant(resolvePolicyIdentityContext().tenantSlug);
  const requestedTenant = normalizeTenant(options.tenantId);
  if (boundTenant && requestedTenant && requestedTenant !== boundTenant) {
    logger.debug(
      `[spend-guard] requested tenant ignored — '${requestedTenant}' differs from the bound tenant '${boundTenant}' | next: none (the bound tenant's caps apply; tenant authorization is the scope layer's) | evidence: requested=${requestedTenant} bound=${boundTenant}`
    );
  }
  const evaluatedTenant = boundTenant ?? requestedTenant;
  const tenantId = evaluatedTenant ?? normalizeTenant(getRegisteredEnvText('KYBERION_TENANT'));
  const policy = resolveSpendPolicyForTenant(options.policy ?? loadSpendPolicy(), tenantId);
  const startOfUtcDay = new Date(now).setUTCHours(0, 0, 0, 0);
  const missionId = options.missionId || getRegisteredEnvText('MISSION_ID') || undefined;
  const spend = options.entries
    ? sumSpend(options.entries, { sinceMs: startOfUtcDay, missionId })
    : loadSpend(now, { sinceMs: startOfUtcDay, missionId, tenant: evaluatedTenant });

  const breached: Array<'daily' | 'mission'> = [];
  if (spend.daily >= policy.daily_cap_usd) breached.push('daily');
  if (missionId && spend.mission >= policy.mission_cap_usd) breached.push('mission');

  const result: SpendGuardResult = {
    allowed: breached.length === 0 || policy.posture === 'warn',
    posture: policy.posture,
    daily_spent_usd: Math.round(spend.daily * 100000) / 100000,
    daily_cap_usd: policy.daily_cap_usd,
    ...(missionId
      ? {
          mission_spent_usd: Math.round(spend.mission * 100000) / 100000,
          mission_cap_usd: policy.mission_cap_usd,
        }
      : {}),
    breached,
  };

  if (breached.length > 0) {
    const dedupeKey = `spend-guard:${tenantId || 'default'}:${breached.join('+')}:${new Date(startOfUtcDay).toISOString().slice(0, 10)}`;
    if (!alertedBreaches.has(dedupeKey)) {
      alertedBreaches.add(dedupeKey);
      const send = options.alert ?? sendOpsAlert;
      try {
        send({
          severity: policy.posture === 'block' ? 'critical' : 'warning',
          title: `LLM spend cap reached (${breached.join(', ')})`,
          context: { ...result },
          recommendation:
            policy.posture === 'block'
              ? 'Reasoning calls are blocked. Approve continuation or raise the cap in spend-policy.json.'
              : 'Warn posture: calls continue. Review the spend distribution before tightening to block.',
          dedupe_key: dedupeKey,
        });
      } catch (err) {
        logger.warn(`[spend-guard] alert emission failed: ${err}`);
      }
    }
    logger.warn(
      `[spend-guard] ${policy.posture}: ${breached.join(', ')} cap reached ` +
        `(daily $${result.daily_spent_usd}/$${result.daily_cap_usd})`
    );
  }
  return result;
}

/**
 * Pre-call enforcement for reasoning backends: no-op in warn posture,
 * throws SpendCapExceededError when the block posture cap is exhausted.
 */
export function enforceSpendGuardForReasoning(missionId?: string): void {
  // Same VITEST pattern as provider-health persistence: unit tests must not
  // read the real metrics history / policy unless they opt in.
  if (isVitestProcess() && getRegisteredEnvText('KYBERION_SPEND_GUARD_TEST') !== '1') return;
  const result = checkSpendGuard({ missionId });
  if (!result.allowed) {
    throw new SpendCapExceededError(result);
  }
}
