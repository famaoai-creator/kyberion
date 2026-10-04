/**
 * org-budget-governor.ts — DL-07: organization-wide daily budget governor.
 *
 * Aggregates the day's token / cost usage per tenant (and optionally
 * organization) across resident dots, missions and media generation, and maps
 * it onto a normal / soft / hard throttle using the `org_budget` section of
 * spend-policy.json. Pure read-side: wiring into the dot runtime is separate.
 */

import * as path from 'node:path';
import { createLogger } from '../logger.js';
import { listDotCharters, type LoadedDotCharter } from '../dot/dot-charter.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { readJsonIfPresent, readJsonLines } from '../foundation/json.js';
import { generationQuotaCounterPath } from '../generation-quota.js';
import { metrics } from '../metrics.js';
import { sendOpsAlert } from '../ops-alert.js';
import { pathResolver } from '../path-resolver.js';

const logger = createLogger('org-budget-governor');

export const DEFAULT_ORG_BUDGET_TOKEN_CAP = 3_000_000;
const DOT_TOKEN_USAGE_REL = 'active/shared/runtime/dot-token-usage.jsonl';
const CACHE_TTL_MS = 60_000;

export interface OrgBudgetPolicy {
  daily_token_cap: number;
  daily_cost_cap_usd?: number;
  soft_ratio: number;
  hard_ratio: number;
  tenant_overrides?: Record<string, Partial<OrgBudgetPolicy>>;
  organization_overrides?: Record<string, Partial<OrgBudgetPolicy>>;
}

export interface OrgBudgetScope {
  tenant_slug?: string;
  organization_id?: string;
}

export interface BudgetUsage {
  scope: OrgBudgetScope;
  day: string;
  tokens: number;
  cost_usd: number;
  /** dots / missions are tokens; generation is generation-quota units (not added to tokens). */
  by_source: { dots: number; missions: number; generation: number };
}

export type BudgetThrottle = 'normal' | 'soft' | 'hard';

export interface BudgetCap {
  daily_token_cap: number;
  daily_cost_cap_usd?: number;
  soft_ratio: number;
  hard_ratio: number;
}

export interface OrgBudgetEvaluation {
  throttle: BudgetThrottle;
  usage: BudgetUsage;
  cap: BudgetCap;
  reason?: string;
}

export interface OrgBudgetDeps {
  rootDir?: string;
  now?: () => Date;
  policy?: OrgBudgetPolicy;
  listCharters?: () => Array<Pick<LoadedDotCharter, 'charter'>>;
  readDotTokenUsage?: () => Array<{ dot_id?: string; day?: string; tokens?: number }>;
  readMetricsHistory?: () => Array<Record<string, any>>;
  readGenerationUnits?: (tenantSlug: string, now: Date) => number;
}

interface RawSpendPolicy {
  daily_cap_usd?: number;
  tenant_overrides?: Record<string, { daily_cap_usd?: number }>;
  org_budget?: OrgBudgetPolicy;
}

const catalog = defineCatalog<RawSpendPolicy>({
  id: 'spend-policy-org-budget',
  path: () => pathResolver.knowledge('product/governance/spend-policy.json'),
  schema: pathResolver.knowledge('product/schemas/spend-policy.schema.json'),
});

let policyCache: { at: number; value: OrgBudgetPolicy } | null = null;

/** Loads `org_budget` (60 s cache; inherits daily_cap_usd as the cost cap). */
export function loadOrgBudgetPolicy(now: () => Date = () => new Date()): OrgBudgetPolicy {
  const t = now().getTime();
  if (policyCache && t - policyCache.at < CACHE_TTL_MS) return policyCache.value;
  const raw = catalog.load();
  const ob = raw.org_budget;
  const value: OrgBudgetPolicy = {
    daily_token_cap: positive(ob?.daily_token_cap)
      ? ob!.daily_token_cap
      : DEFAULT_ORG_BUDGET_TOKEN_CAP,
    ...(positive(ob?.daily_cost_cap_usd)
      ? { daily_cost_cap_usd: ob!.daily_cost_cap_usd }
      : positive(raw.daily_cap_usd)
        ? { daily_cost_cap_usd: raw.daily_cap_usd }
        : {}),
    soft_ratio: positive(ob?.soft_ratio) ? ob!.soft_ratio : 0.8,
    hard_ratio: positive(ob?.hard_ratio) ? ob!.hard_ratio : 1,
    ...(ob?.tenant_overrides ? { tenant_overrides: ob.tenant_overrides } : {}),
    ...(ob?.organization_overrides ? { organization_overrides: ob.organization_overrides } : {}),
  };
  policyCache = { at: t, value };
  return value;
}

/** Test hook: drop the 60 s policy cache. */
export function resetOrgBudgetPolicyCache(): void {
  policyCache = null;
}

function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function resolveCap(policy: OrgBudgetPolicy, scope: OrgBudgetScope): BudgetCap {
  const cap: BudgetCap = {
    daily_token_cap: policy.daily_token_cap,
    ...(policy.daily_cost_cap_usd !== undefined
      ? { daily_cost_cap_usd: policy.daily_cost_cap_usd }
      : {}),
    soft_ratio: policy.soft_ratio,
    hard_ratio: policy.hard_ratio,
  };
  const layers = [
    scope.tenant_slug ? policy.tenant_overrides?.[scope.tenant_slug] : undefined,
    scope.organization_id ? policy.organization_overrides?.[scope.organization_id] : undefined,
  ];
  for (const o of layers) {
    if (!o) continue;
    if (positive(o.daily_token_cap)) cap.daily_token_cap = o.daily_token_cap;
    if (positive(o.daily_cost_cap_usd)) cap.daily_cost_cap_usd = o.daily_cost_cap_usd;
    if (positive(o.soft_ratio)) cap.soft_ratio = o.soft_ratio;
    if (positive(o.hard_ratio)) cap.hard_ratio = o.hard_ratio;
  }
  return cap;
}

function inScope(
  scope: OrgBudgetScope,
  row: { tenant_slug?: string; organization_id?: string }
): boolean {
  if (scope.tenant_slug && row.tenant_slug !== scope.tenant_slug) return false;
  if (scope.organization_id && row.organization_id !== scope.organization_id) return false;
  return true;
}

function metricsTokens(entry: Record<string, any>): number {
  const u = entry.usage;
  if (!u || typeof u !== 'object') return 0;
  const sum = [
    u.prompt_tokens,
    u.completion_tokens,
    u.cache_read_tokens ?? u.cache_read_input_tokens,
    u.cache_write_tokens ?? u.cache_creation_input_tokens,
    u.cache_write_1h_tokens,
  ].reduce((acc: number, v) => acc + (Number(v) > 0 ? Number(v) : 0), 0);
  return sum;
}

export function computeBudgetUsage(scope: OrgBudgetScope, deps: OrgBudgetDeps = {}): BudgetUsage {
  const now = deps.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const root = deps.rootDir ?? pathResolver.rootDir();

  // Dots: token ledger joined to charter tenant/org scope.
  const dotScope = new Map<string, { tenant_slug?: string; organization_id?: string }>();
  try {
    const loaded = deps.listCharters ? deps.listCharters() : listDotCharters(root, { errors: [] });
    for (const { charter } of loaded) {
      dotScope.set(charter.dot_id, {
        tenant_slug: charter.scope?.tenant_slug,
        organization_id: charter.scope?.organization_id,
      });
    }
  } catch (error) {
    logger.warn(
      `charter listing failed — dot usage may be undercounted | next: pnpm kyberion dot validate | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let dots = 0;
  try {
    const rows = deps.readDotTokenUsage
      ? deps.readDotTokenUsage()
      : readJsonLines<{ dot_id?: string; day?: string; tokens?: number }>(
          path.join(root, DOT_TOKEN_USAGE_REL),
          { onMalformed: 'skip' }
        );
    for (const row of rows) {
      if (row?.day !== day || !row.dot_id || !(Number(row.tokens) > 0)) continue;
      const s = dotScope.get(row.dot_id) ?? {};
      if (inScope(scope, s)) dots += Number(row.tokens);
    }
  } catch (error) {
    logger.warn(
      `dot token usage unreadable — ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Missions / reasoning calls: metrics history rows tagged with tenant.
  let missions = 0;
  let cost = 0;
  try {
    const entries = deps.readMetricsHistory ? deps.readMetricsHistory() : metrics.loadHistory();
    for (const e of entries) {
      if (typeof e?.timestamp !== 'string' || e.timestamp.slice(0, 10) !== day) continue;
      const rowScope = {
        tenant_slug: e.tenant_slug ?? e.tenant,
        organization_id: e.organization_id,
      };
      if (!inScope(scope, rowScope)) continue;
      missions += metricsTokens(e);
      const c = Number(e.cost_usd);
      if (Number.isFinite(c) && c > 0) cost += c;
    }
  } catch (error) {
    logger.warn(
      `metrics history unreadable — ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let generation = 0;
  if (scope.tenant_slug) {
    try {
      generation = deps.readGenerationUnits
        ? deps.readGenerationUnits(scope.tenant_slug, now)
        : (readJsonIfPresent<{ units?: number }>(
            generationQuotaCounterPath(scope.tenant_slug, { rootDir: root, now })
          )?.units ?? 0);
    } catch {
      generation = 0;
    }
  }

  return {
    scope: { ...scope },
    day,
    tokens: dots + missions,
    cost_usd: Math.round(cost * 100000) / 100000,
    by_source: { dots, missions, generation: Number(generation) || 0 },
  };
}

export function evaluateBudgetThrottle(
  scope: OrgBudgetScope,
  deps: OrgBudgetDeps = {}
): OrgBudgetEvaluation {
  const policy = deps.policy ?? loadOrgBudgetPolicy(deps.now);
  const cap = resolveCap(policy, scope);
  const usage = computeBudgetUsage(scope, deps);
  const tokenRatio = usage.tokens / cap.daily_token_cap;
  const costRatio = cap.daily_cost_cap_usd ? usage.cost_usd / cap.daily_cost_cap_usd : 0;
  const ratio = Math.max(tokenRatio, costRatio);
  const basis =
    costRatio > tokenRatio
      ? `cost $${usage.cost_usd}/$${cap.daily_cost_cap_usd}`
      : `tokens ${usage.tokens}/${cap.daily_token_cap}`;
  if (ratio >= cap.hard_ratio) {
    return { throttle: 'hard', usage, cap, reason: `hard budget limit reached (${basis})` };
  }
  if (ratio >= cap.soft_ratio) {
    return { throttle: 'soft', usage, cap, reason: `soft budget threshold reached (${basis})` };
  }
  return { throttle: 'normal', usage, cap };
}

const alerted = new Set<string>();

/** Sends at most one ops alert per scope/day/throttle crossing. Returns true if sent. */
export function maybeAlertBudgetThreshold(
  evaluation: OrgBudgetEvaluation,
  options: { alert?: typeof sendOpsAlert; scopeLabel?: string } = {}
): boolean {
  if (evaluation.throttle === 'normal') return false;
  const { scope, day } = evaluation.usage;
  const label = options.scopeLabel ?? (scope.tenant_slug || scope.organization_id || 'global');
  const key = `org-budget:${label}:${day}:${evaluation.throttle}`;
  if (alerted.has(key)) return false;
  alerted.add(key);
  try {
    (options.alert ?? sendOpsAlert)({
      severity: evaluation.throttle === 'hard' ? 'critical' : 'warning',
      title: `Organization budget ${evaluation.throttle} threshold (${label})`,
      context: { ...evaluation.usage, cap: evaluation.cap, reason: evaluation.reason },
      recommendation:
        evaluation.throttle === 'hard'
          ? 'Resident dot wakes are paused for this scope today. Raise org_budget in spend-policy.json or wait for the UTC day rollover.'
          : 'Dot proposals now require approval. Review usage before the hard limit pauses wakes.',
      dedupe_key: key,
      category: 'budget',
    });
  } catch (error) {
    logger.warn(
      `budget alert emission failed — ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return true;
}

/** Test hook: forget which alerts were already sent. */
export function resetOrgBudgetAlertState(): void {
  alerted.clear();
}
