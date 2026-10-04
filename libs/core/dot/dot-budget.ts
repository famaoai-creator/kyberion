/**
 * Dot budget wiring (DL-07) — connects the organization budget governor to
 * the resident-dot loop.
 *
 * - `dotBudgetThrottle(charter)` evaluates the charter's tenant / organization
 *   scope (60 s cache per scope) and raises at most one ops alert per scope,
 *   day and threshold.
 * - floor contributor `budget-soft`: at soft or hard throttle every proposal
 *   needs operator approval.
 * - the supervisor skips wakes and the executor skips work for a dot whose
 *   scope is at the hard limit (housekeeping and heartbeats continue).
 * - status section `budget` and a digest line make the throttle visible.
 */

import { createLogger } from '../logger.js';
import {
  evaluateBudgetThrottle,
  maybeAlertBudgetThreshold,
  type BudgetThrottle,
  type OrgBudgetDeps,
  type OrgBudgetEvaluation,
  type OrgBudgetScope,
} from '../governance/org-budget-governor.js';
import type { sendOpsAlert } from '../ops-alert.js';
import type { DotCharter } from './dot-charter.js';
import type { DotDigestSection, DotFloorContributor, DotStatusSection } from './dot-extensions.js';

const logger = createLogger('dot-budget');

/** The governor throttle as seen by dot callers (scripts import it from here). */
export type DotBudgetThrottle = BudgetThrottle;

/** Same window as the governor's policy cache. */
export const DOT_BUDGET_CACHE_MS = 60_000;

export interface DotBudgetDeps extends OrgBudgetDeps {
  /** Governor port (test seam); defaults to {@link evaluateBudgetThrottle}. */
  evaluate?: (scope: OrgBudgetScope, deps: OrgBudgetDeps) => OrgBudgetEvaluation;
  /** Ops-alert port handed to {@link maybeAlertBudgetThreshold}. */
  alert?: typeof sendOpsAlert;
  /** Cache window; 0 disables the cache. */
  cacheMs?: number;
}

const cache = new Map<string, { at: number; value: OrgBudgetEvaluation }>();

/** Test hook: forget cached evaluations. */
export function resetDotBudgetCache(): void {
  cache.clear();
}

/** The budget scope a charter spends against: its tenant and organization. */
export function dotBudgetScope(charter: DotCharter): OrgBudgetScope {
  return {
    ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
    ...(charter.scope.organization_id ? { organization_id: charter.scope.organization_id } : {}),
  };
}

/** Evaluate the charter's budget throttle (cached per scope) and alert on a threshold crossing. */
export function dotBudgetThrottle(
  charter: DotCharter,
  deps: DotBudgetDeps = {}
): OrgBudgetEvaluation {
  const { evaluate, alert, cacheMs, ...governorDeps } = deps;
  const scope = dotBudgetScope(charter);
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const ttl = cacheMs ?? DOT_BUDGET_CACHE_MS;
  const key = [deps.rootDir ?? '', scope.tenant_slug ?? '', scope.organization_id ?? ''].join(
    '\u0000'
  );
  const hit = cache.get(key);
  if (ttl > 0 && hit && nowMs - hit.at < ttl) return hit.value;
  const value = (evaluate ?? evaluateBudgetThrottle)(scope, governorDeps);
  if (ttl > 0) cache.set(key, { at: nowMs, value });
  maybeAlertBudgetThreshold(value, alert ? { alert } : {});
  return value;
}

function ratioPct(evaluation: OrgBudgetEvaluation): number {
  const cap = evaluation.cap.daily_token_cap;
  return cap > 0 ? Math.round((evaluation.usage.tokens / cap) * 100) : 0;
}

function throttleOf(charter: DotCharter, rootDir: string | undefined, now: () => Date) {
  return dotBudgetThrottle(charter, { rootDir, now });
}

/** True when the charter's scope is at the hard limit (no wakes, no executor work). */
export function dotBudgetHardThrottled(charter: DotCharter, deps: DotBudgetDeps = {}): boolean {
  return dotBudgetThrottle(charter, deps).throttle === 'hard';
}

export const DOT_BUDGET_FLOOR_CONTRIBUTOR: DotFloorContributor = {
  id: 'budget-soft',
  floor(c, _p, ctx) {
    const evaluation = throttleOf(c, ctx.rootDir, ctx.now);
    if (evaluation.throttle === 'normal') return undefined;
    logger.debug(
      `budget ${evaluation.throttle} for ${c.dot_id}: proposals need approval (${evaluation.reason ?? 'threshold reached'})`
    );
    return 'approve';
  },
};

export const DOT_BUDGET_STATUS_SECTION: DotStatusSection = {
  id: 'budget',
  collect(c, ctx) {
    const evaluation = throttleOf(c, ctx.rootDir, ctx.now);
    return {
      throttle: evaluation.throttle satisfies BudgetThrottle,
      day: evaluation.usage.day,
      tokens: evaluation.usage.tokens,
      daily_token_cap: evaluation.cap.daily_token_cap,
      used_pct: ratioPct(evaluation),
      soft_at_pct: Math.round(evaluation.cap.soft_ratio * 100),
      hard_at_pct: Math.round(evaluation.cap.hard_ratio * 100),
      cost_usd: evaluation.usage.cost_usd,
      ...(evaluation.cap.daily_cost_cap_usd !== undefined
        ? { daily_cost_cap_usd: evaluation.cap.daily_cost_cap_usd }
        : {}),
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    };
  },
};

export const DOT_BUDGET_DIGEST_SECTION: DotDigestSection = {
  id: 'budget',
  lines(c, _since, ctx) {
    const evaluation = throttleOf(c, ctx.rootDir, ctx.now);
    const line = `Budget: ${ratioPct(evaluation)}% of daily tokens (soft at ${Math.round(evaluation.cap.soft_ratio * 100)}%)`;
    return evaluation.throttle === 'normal'
      ? [line]
      : [`${line} — ${evaluation.throttle} throttle: ${evaluation.reason ?? 'threshold reached'}`];
  },
};
