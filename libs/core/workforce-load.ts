import { defineCatalog } from './foundation/governed-catalog.js';
import * as pathResolver from './path-resolver.js';
import { listWorkItems } from './work-coordination.js';
import { resolveCostRateModelKey, resolveCostRates } from './metrics.js';

/**
 * TC-08: the workforce's observed load and price, as data.
 *
 * `WorkforceResourceRef` has carried `availability` and `cost_profile` since
 * the actor-neutral staffing model was introduced, but both were written as
 * constants (`{ status: 'available' }` and `{}`), so nothing downstream could
 * tell a free actor from a saturated one or a cheap model from an expensive
 * one. The signals already existed — work items record their assignee, their
 * lease and their scope; the model cost registry records per-token rates —
 * they were simply never read.
 *
 * Load is derived from the work-item store rather than the in-process agent
 * registry on purpose: the registry only knows about runtimes in the current
 * process, while work items are the durable, cross-process record of what an
 * actor is actually carrying.
 */
export interface WorkforceCapacityPolicy {
  version: string;
  thresholds: {
    busy_at_active_items: number;
    saturated_at_active_items: number;
  };
  selection: {
    load_penalty_per_active_item: number;
    queued_penalty_per_item: number;
    saturated_penalty: number;
    max_load_penalty?: number;
  };
}

const FALLBACK_POLICY: WorkforceCapacityPolicy = {
  version: '1.0.0',
  thresholds: { busy_at_active_items: 1, saturated_at_active_items: 3 },
  selection: {
    load_penalty_per_active_item: 4,
    queued_penalty_per_item: 1,
    saturated_penalty: 12,
    max_load_penalty: 18,
  },
};

const capacityPolicyCatalog = defineCatalog<WorkforceCapacityPolicy>({
  id: 'workforce-capacity-policy',
  path: () => pathResolver.knowledge('product/governance/workforce-capacity-policy.json'),
  schema: pathResolver.knowledge('product/schemas/workforce-capacity-policy.schema.json'),
  fallback: FALLBACK_POLICY,
});

export function loadWorkforceCapacityPolicy(): WorkforceCapacityPolicy {
  return capacityPolicyCatalog.load();
}

export function resetWorkforceCapacityPolicy(): void {
  capacityPolicyCatalog.reset();
}

export type WorkforceAvailabilityStatus = 'available' | 'busy' | 'saturated';

export interface WorkforceLoadSnapshot {
  resource_id: string;
  status: WorkforceAvailabilityStatus;
  /** Claimed work items currently in progress. */
  active_work_items: number;
  /** Work items assigned and ready, but not started. */
  queued_work_items: number;
  /** In-progress items still holding a lease. */
  active_leases: number;
  /** Scopes (project / mission ids) the actor currently holds work in. */
  leased_scopes: string[];
  observed_at: string;
}

export type WorkforceLoadIndex = Map<string, WorkforceLoadSnapshot>;

function emptySnapshot(resourceId: string, observedAt: string): WorkforceLoadSnapshot {
  return {
    resource_id: resourceId,
    status: 'available',
    active_work_items: 0,
    queued_work_items: 0,
    active_leases: 0,
    leased_scopes: [],
    observed_at: observedAt,
  };
}

function classify(
  snapshot: WorkforceLoadSnapshot,
  policy: WorkforceCapacityPolicy
): WorkforceAvailabilityStatus {
  if (snapshot.active_work_items >= policy.thresholds.saturated_at_active_items) {
    return 'saturated';
  }
  if (snapshot.active_work_items >= policy.thresholds.busy_at_active_items) return 'busy';
  return 'available';
}

/**
 * One pass over the work-item store, indexed by assignee. Callers that score
 * several actors (team composition) build this once and pass it down rather
 * than re-reading the store per candidate.
 */
export function collectWorkforceLoad(): WorkforceLoadIndex {
  const policy = loadWorkforceCapacityPolicy();
  const observedAt = new Date().toISOString();
  const index: WorkforceLoadIndex = new Map();

  let items: ReturnType<typeof listWorkItems>;
  try {
    items = listWorkItems({});
  } catch {
    // Load is an optimization signal, never a gate: an unreadable store means
    // "no load information", not "nobody may be selected".
    return index;
  }

  for (const item of items) {
    const resourceId = item.assignee_peer_id?.trim();
    if (!resourceId) continue;
    const snapshot = index.get(resourceId) || emptySnapshot(resourceId, observedAt);
    if (item.status === 'in_progress') {
      snapshot.active_work_items += 1;
      if (item.lease_id && !item.released_at) snapshot.active_leases += 1;
      const scope = item.project_id?.trim();
      if (scope && !snapshot.leased_scopes.includes(scope)) snapshot.leased_scopes.push(scope);
    } else if (item.status === 'ready') {
      snapshot.queued_work_items += 1;
    }
    index.set(resourceId, snapshot);
  }

  for (const snapshot of index.values()) {
    snapshot.status = classify(snapshot, policy);
    snapshot.leased_scopes.sort();
  }
  return index;
}

export function resolveWorkforceLoad(
  resourceId: string,
  index?: WorkforceLoadIndex
): WorkforceLoadSnapshot {
  const resolved = (index || collectWorkforceLoad()).get(resourceId);
  return resolved || emptySnapshot(resourceId, new Date().toISOString());
}

/** The `availability` block persisted on a staffed workforce resource. */
export function buildAvailabilityRecord(
  resourceId: string,
  index?: WorkforceLoadIndex
): Record<string, unknown> {
  const snapshot = resolveWorkforceLoad(resourceId, index);
  return {
    status: snapshot.status,
    active_work_items: snapshot.active_work_items,
    queued_work_items: snapshot.queued_work_items,
    active_leases: snapshot.active_leases,
    leased_scopes: snapshot.leased_scopes,
    observed_at: snapshot.observed_at,
  };
}

/**
 * The `cost_profile` block persisted on a staffed workforce resource: the
 * governed per-token rates for the model the actor runs on, so cost is
 * attributable at staffing time instead of only after the fact in metrics.
 */
export function buildCostProfileRecord(input: {
  provider?: string | null;
  modelId?: string | null;
}): Record<string, unknown> {
  const modelId = input.modelId?.trim();
  if (!modelId) return {};
  const rates = resolveCostRates(modelId);
  // Several providers report a display name ("Gemini 3.6 Flash (Medium)")
  // rather than a registry id, which matches nothing and silently resolves to
  // the registry default. Record which rate this is so a default is never
  // read as a measured price.
  const registryKey = resolveCostRateModelKey(modelId);
  return {
    provider: input.provider || null,
    model_id: modelId,
    ...(registryKey ? { registry_model_id: registryKey } : {}),
    rate_source: registryKey ? 'registry' : 'registry_default',
    currency: 'USD',
    unit: 'per_token',
    prompt: rates.prompt,
    completion: rates.completion,
    ...(rates.cache_read === undefined ? {} : { cache_read: rates.cache_read }),
    ...(rates.cache_write === undefined ? {} : { cache_write: rates.cache_write }),
  };
}
