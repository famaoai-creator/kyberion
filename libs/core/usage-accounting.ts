/** PI-01: stable usage-cause vocabulary and accounting helpers. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';

/** Cost certainty is independent of execution/commitment lifecycle status. */
export type UsageCostStatus = 'actual' | 'estimated' | 'included' | 'unknown';
export type UsageBillingMode = 'metered' | 'subscription_included' | 'unknown';
export type UsageSource = 'provider' | 'character_estimate' | 'unknown';
export type UsageCostSource = 'provider_report' | 'model_registry' | 'none';

export interface UsageCostAccounting {
  cost_status?: UsageCostStatus;
  billing_mode?: UsageBillingMode;
  usage_source?: UsageSource;
  cost_source?: UsageCostSource;
  reported_cost_usd?: number;
  reference_cost_usd?: number;
}

export interface ResolvedUsageCostAccounting extends UsageCostAccounting {
  cost_status: UsageCostStatus;
  billing_mode: UsageBillingMode;
  usage_source: UsageSource;
  cost_source: UsageCostSource;
  /** Incremental cash cost; null means unavailable, never free. */
  cost_usd: number | null;
}

export function finiteNonNegativeUsageCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const USAGE_COST_EVIDENCE_FIELDS = [
  'cost_usd',
  'sdk_cost_usd',
  'reported_cost_usd',
  'reference_cost_usd',
  'cost_status',
  'billing_mode',
  'usage_source',
  'cost_source',
  'usage',
  'prompt_tokens',
  'completion_tokens',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'total_cost_usd',
  'estimated_cost_usd',
] as const;

/** Operational duration/memory metrics are not evidence of a billable call. */
export function hasUsageCostEvidence(
  input: Partial<Record<(typeof USAGE_COST_EVIDENCE_FIELDS)[number] | 'type', unknown>>
): boolean {
  return (
    input.type === 'resource_usage' ||
    USAGE_COST_EVIDENCE_FIELDS.some((field) => input[field] !== undefined)
  );
}

/** Resolve new evidence and legacy ledger rows without inventing a billable price. */
export function resolveUsageCostAccounting(input: {
  cost_status?: unknown;
  billing_mode?: unknown;
  usage_source?: unknown;
  cost_source?: unknown;
  reported_cost_usd?: unknown;
  reference_cost_usd?: unknown;
  cost_usd?: unknown;
  sdk_cost_usd?: unknown;
  estimated?: unknown;
  status?: unknown;
  source?: unknown;
}): ResolvedUsageCostAccounting {
  const reported =
    finiteNonNegativeUsageCost(input.reported_cost_usd) ??
    finiteNonNegativeUsageCost(input.sdk_cost_usd);
  const computed = finiteNonNegativeUsageCost(input.cost_usd);
  const reference = finiteNonNegativeUsageCost(input.reference_cost_usd);
  const referenceSource: UsageCostSource =
    input.cost_source === 'provider_report' || input.cost_source === 'model_registry'
      ? input.cost_source
      : 'none';
  const included =
    input.billing_mode === 'subscription_included' || input.cost_status === 'included';
  const usageSource: UsageSource =
    input.usage_source === 'provider' || input.usage_source === 'character_estimate'
      ? input.usage_source
      : 'unknown';
  const billingMode: UsageBillingMode = included
    ? 'subscription_included'
    : input.billing_mode === 'metered'
      ? 'metered'
      : input.billing_mode === undefined && (reported !== undefined || computed !== undefined)
        ? 'metered'
        : 'unknown';
  const base = {
    billing_mode: billingMode,
    usage_source: usageSource,
    ...(reported !== undefined ? { reported_cost_usd: reported } : {}),
    ...(reference !== undefined ? { reference_cost_usd: reference } : {}),
  };
  if (included)
    return {
      ...base,
      cost_status: 'included',
      cost_usd: 0,
      cost_source:
        reported !== undefined
          ? 'provider_report'
          : (reference ?? computed) !== undefined
            ? referenceSource
            : 'none',
      ...((reference ?? reported ?? computed) !== undefined
        ? { reference_cost_usd: reference ?? reported ?? computed }
        : {}),
    };
  if (reported !== undefined)
    return { ...base, cost_status: 'actual', cost_source: 'provider_report', cost_usd: reported };
  if (
    input.source === 'direct_cli' ||
    input.cost_status === 'unknown' ||
    (input.billing_mode === 'unknown' && computed !== undefined) ||
    computed === undefined
  )
    return {
      ...base,
      cost_status: 'unknown',
      cost_source: reference !== undefined ? referenceSource : 'none',
      cost_usd: null,
    };
  const estimated =
    input.cost_status === 'estimated' || input.estimated === true || input.status === 'estimated';
  return {
    ...base,
    cost_status: estimated ? 'estimated' : 'actual',
    cost_usd: computed,
    cost_source:
      input.cost_source === 'provider_report'
        ? 'provider_report'
        : input.cost_source === 'model_registry' || estimated
          ? 'model_registry'
          : 'none',
  };
}

export interface UsageAttribution {
  readonly actor_id: string;
  /** One trusted execution attempt, shared by provider evidence and its ledger charge. */
  readonly accounting_id?: string;
  readonly scope: Readonly<EventScope>;
}

const usageAttribution = new AsyncLocalStorage<UsageAttribution>();

/**
 * Bind metering labels from a trusted runtime/charter, never model tool input.
 * This carries attribution only; it does not confer execution authority.
 */
export function withUsageAttribution<T>(
  input: { actor_id: string; accounting_id?: string; scope: EventScopeInput },
  fn: () => T
): T {
  const actor_id = input.actor_id.trim();
  if (!actor_id) throw new Error('usage attribution requires an actor_id');
  const scope = Object.freeze(normalizeEventScope(input.scope));
  const accounting_id = input.accounting_id?.trim();
  return usageAttribution.run(
    Object.freeze({ actor_id, scope, ...(accounting_id ? { accounting_id } : {}) }),
    fn
  );
}

export function getUsageAttribution(): UsageAttribution | undefined {
  return usageAttribution.getStore();
}

export const USAGE_CAUSES = [
  'assistant',
  'tool',
  'hook',
  'compaction',
  'branch_summary',
  'deferred_fetch',
  'judge',
  'subagent',
  'repair',
  'adjustment',
] as const;

export type UsageCause = (typeof USAGE_CAUSES)[number];

export function normalizeUsageCause(value: unknown): UsageCause {
  return typeof value === 'string' && (USAGE_CAUSES as readonly string[]).includes(value)
    ? (value as UsageCause)
    : 'assistant';
}
