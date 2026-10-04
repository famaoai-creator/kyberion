/** PI-01: stable usage-cause vocabulary and accounting helpers. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';

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
