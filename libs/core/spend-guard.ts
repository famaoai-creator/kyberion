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
import { metrics } from './metrics.js';
import { sendOpsAlert } from './ops-alert.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export interface SpendPolicy {
  posture: 'warn' | 'block';
  daily_cap_usd: number;
  mission_cap_usd: number;
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

const DEFAULT_POLICY: SpendPolicy = {
  posture: 'warn',
  daily_cap_usd: 50,
  mission_cap_usd: 20,
};

export function loadSpendPolicy(): SpendPolicy {
  if (!safeExistsSync(POLICY_PATH)) return DEFAULT_POLICY;
  try {
    const parsed = JSON.parse(
      String(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) || '{}')
    ) as Partial<SpendPolicy>;
    return {
      posture: parsed.posture === 'block' ? 'block' : 'warn',
      daily_cap_usd:
        Number(parsed.daily_cap_usd) > 0
          ? Number(parsed.daily_cap_usd)
          : DEFAULT_POLICY.daily_cap_usd,
      mission_cap_usd:
        Number(parsed.mission_cap_usd) > 0
          ? Number(parsed.mission_cap_usd)
          : DEFAULT_POLICY.mission_cap_usd,
    };
  } catch {
    // A broken policy file must not silently disable the guard.
    return DEFAULT_POLICY;
  }
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

// Reading the metrics history is file I/O; cache briefly so the guard adds
// no measurable latency to bursts of reasoning calls.
const CACHE_TTL_MS = 30_000;
let cachedAt = 0;
let cachedEntries: UsageEntry[] | null = null;

function loadUsageEntries(now: number): UsageEntry[] {
  if (cachedEntries && now - cachedAt < CACHE_TTL_MS) return cachedEntries;
  cachedEntries = metrics.loadHistory() as UsageEntry[];
  cachedAt = now;
  return cachedEntries;
}

/** Test hook: drop the usage cache. */
export function resetSpendGuardCache(): void {
  cachedEntries = null;
  cachedAt = 0;
}

const alertedBreaches = new Set<string>();

export function checkSpendGuard(
  options: {
    missionId?: string;
    now?: number;
    entries?: UsageEntry[];
    policy?: SpendPolicy;
    alert?: typeof sendOpsAlert;
  } = {}
): SpendGuardResult {
  const now = options.now ?? Date.now();
  const policy = options.policy ?? loadSpendPolicy();
  const startOfUtcDay = new Date(now).setUTCHours(0, 0, 0, 0);
  const missionId = options.missionId || process.env.MISSION_ID || undefined;
  const entries = options.entries ?? loadUsageEntries(now);
  const spend = sumSpend(entries, { sinceMs: startOfUtcDay, missionId });

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
    const dedupeKey = `spend-guard:${breached.join('+')}:${new Date(startOfUtcDay).toISOString().slice(0, 10)}`;
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
  if (process.env.VITEST && process.env.KYBERION_SPEND_GUARD_TEST !== '1') return;
  const result = checkSpendGuard({ missionId });
  if (!result.allowed) {
    throw new SpendCapExceededError(result);
  }
}
