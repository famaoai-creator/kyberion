/**
 * org-budget-governor.ts — DL-07: organization-wide daily budget governor.
 *
 * Aggregates the day's token / cost usage per tenant (and optionally
 * organization) across resident dots, missions and media generation, and maps
 * it onto a normal / soft / hard throttle using the `org_budget` section of
 * spend-policy.json. Pure read-side: wiring into the dot runtime is separate.
 *
 * Sources and attribution:
 * - dots: `dot-token-usage.jsonl` joined to each charter's tenant/org scope.
 * - missions / reasoning: metrics-history rows, scoped by `scope.tenant_slug`
 *   / `scope.organization_id` (EventScope written by MetricsCollector.record
 *   callers), with legacy top-level `tenant_slug` / `tenant` fallbacks.
 *   Reasoning backends meter dot wakes too, without a dot marker; so tokens of
 *   rows that are dot-tagged (`agent`/`actor_id`/`component` `dot:*`, or a
 *   `dot_id` field) or wholly unattributed (no mission_id, no scope, no
 *   tenant) are not added — the dot ledger already counts them. Their cost
 *   still counts (the dot ledger carries no cost).
 * - generation: generation-quota units, report-only — never part of the
 *   token total nor the throttle.
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
  /**
   * dots / missions are tokens; generation is generation-quota units — report
   * only: never added to `tokens` and never an input to the throttle.
   */
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
  /** evaluateBudgetThrottle cache window per scope (default 60 s); 0 disables it. */
  throttleCacheMs?: number;
}

/** The spend-policy.json fields the governor reads. */
export interface RawSpendPolicy {
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

/**
 * Map spend-policy.json onto the governor policy: `org_budget` values, the
 * global `daily_cap_usd` as the default cost cap, and each spend-policy
 * `tenant_overrides[slug].daily_cap_usd` as that tenant's cost cap.
 */
export function resolveOrgBudgetPolicy(raw: RawSpendPolicy): OrgBudgetPolicy {
  const ob = raw.org_budget;
  return {
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
    ...tenantOverridesWithSpendCaps(raw, ob),
    ...(ob?.organization_overrides ? { organization_overrides: ob.organization_overrides } : {}),
  };
}

/** Loads `org_budget` from spend-policy.json (60 s cache); see {@link resolveOrgBudgetPolicy}. */
export function loadOrgBudgetPolicy(now: () => Date = () => new Date()): OrgBudgetPolicy {
  const t = now().getTime();
  if (policyCache && t - policyCache.at < CACHE_TTL_MS) return policyCache.value;
  const value = resolveOrgBudgetPolicy(catalog.load());
  policyCache = { at: t, value };
  return value;
}

/**
 * org_budget.tenant_overrides, plus spend-policy `tenant_overrides[slug].daily_cap_usd`
 * inherited as that tenant's cost cap when org_budget sets none for it.
 */
function tenantOverridesWithSpendCaps(
  raw: RawSpendPolicy,
  ob: OrgBudgetPolicy | undefined
): Pick<OrgBudgetPolicy, 'tenant_overrides'> {
  const merged: Record<string, Partial<OrgBudgetPolicy>> = { ...(ob?.tenant_overrides ?? {}) };
  for (const [slug, spend] of Object.entries(raw.tenant_overrides ?? {})) {
    if (!positive(spend?.daily_cap_usd)) continue;
    const existing = merged[slug] ?? {};
    if (positive(existing.daily_cost_cap_usd)) continue;
    merged[slug] = { ...existing, daily_cost_cap_usd: spend.daily_cap_usd };
  }
  return Object.keys(merged).length || ob?.tenant_overrides ? { tenant_overrides: merged } : {};
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

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Tenant/org of a metrics row: canonical `scope` first, then legacy top-level fields. */
function metricsRowScope(e: Record<string, any>): OrgBudgetScope {
  const scope = e.scope && typeof e.scope === 'object' ? e.scope : {};
  return {
    tenant_slug: nonEmpty(scope.tenant_slug) ?? nonEmpty(e.tenant_slug) ?? nonEmpty(e.tenant),
    organization_id: nonEmpty(scope.organization_id) ?? nonEmpty(e.organization_id),
  };
}

const DOT_ACTOR_PATTERN = /^dot:/;

/**
 * Rows whose tokens the dot ledger already counts: explicitly dot-tagged, or
 * wholly unattributed reasoning (backends meter dot wakes with no mission,
 * scope or tenant — the resident daemon's only unscoped reasoning source).
 */
function isDotAttributableMetricsRow(e: Record<string, any>, rowScope: OrgBudgetScope): boolean {
  if (nonEmpty(e.dot_id) || nonEmpty(e.scope?.dot_id)) return true;
  if (
    [e.agent, e.actor_id, e.component].some(
      (v) => typeof v === 'string' && DOT_ACTOR_PATTERN.test(v)
    )
  ) {
    return true;
  }
  return !nonEmpty(e.mission_id) && !e.scope && !rowScope.tenant_slug && !rowScope.organization_id;
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
      const rowScope = metricsRowScope(e);
      if (!inScope(scope, rowScope)) continue;
      if (!isDotAttributableMetricsRow(e, rowScope)) missions += metricsTokens(e);
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

const throttleCache = new Map<string, { at: number; value: OrgBudgetEvaluation }>();

/** Test hook: drop cached throttle evaluations. */
export function resetOrgBudgetThrottleCache(): void {
  throttleCache.clear();
}

/** Throttle for a scope; cached per scope (and UTC day) for `throttleCacheMs` (60 s). */
export function evaluateBudgetThrottle(
  scope: OrgBudgetScope,
  deps: OrgBudgetDeps = {}
): OrgBudgetEvaluation {
  const now = deps.now?.() ?? new Date();
  const ttl = deps.throttleCacheMs ?? CACHE_TTL_MS;
  const key = [
    deps.rootDir ?? '',
    scope.tenant_slug ?? '',
    scope.organization_id ?? '',
    now.toISOString().slice(0, 10),
  ].join('\u0000');
  const hit = throttleCache.get(key);
  if (ttl > 0 && hit && now.getTime() - hit.at < ttl) return hit.value;
  const value = computeBudgetThrottle(scope, deps);
  if (ttl > 0) throttleCache.set(key, { at: now.getTime(), value });
  return value;
}

function computeBudgetThrottle(scope: OrgBudgetScope, deps: OrgBudgetDeps): OrgBudgetEvaluation {
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
