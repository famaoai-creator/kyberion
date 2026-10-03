import { randomUUID } from 'node:crypto';
import {
  cancelApprovalRequest,
  expireApprovalRequest,
  isApprovalRequestExpired,
  loadApprovalRequest,
} from './governance/approval-store.js';
import type { HeldActionDecision, HeldActionRecord } from './cloudflare-os-control-plane.js';
import { isValidTenantSlug } from './entity-scope.js';
import { SHARED_TENANT, tryResolveOwnerScope } from './owner-scope.js';
import {
  declassificationKeyOf,
  type DeclassificationGrant,
} from './cloudflare-os-control-plane-state.js';

/**
 * Held-action lifecycle rules that keep a state from becoming unreachable:
 * what a dependent may do given its dependencies, how a decision taken in the
 * shared approval store reaches a held action whose bridge never delivered it,
 * and the declassify grant (moved here to keep the plane within its size limit).
 */

/**
 * Held links are minted under mission_controller only. Calling the approval
 * store with that literal (never the record's own `role` field) keeps the
 * role it assumes statically known, and a tampered or migrated record that
 * names another role fails closed before any write.
 */
const HELD_APPROVAL_ROLE = 'mission_controller' as const;

function assertHeldApprovalRole(role: string): void {
  if (role !== HELD_APPROVAL_ROLE) {
    throw new Error(
      `[POLICY_VIOLATION] Held approval request role '${role}' is not ${HELD_APPROVAL_ROLE}`
    );
  }
}

export type DependencyReadiness = 'ready' | 'wait' | 'dead';

/**
 * A dependent may run only after every dependency has been applied. One that
 * was rejected, cancelled, failed or does not exist can never be applied, so
 * the dependent is `dead` (and gets cancelled) rather than left to wait forever.
 */
export function dependencyReadiness(
  record: Pick<HeldActionRecord, 'dependsOn'>,
  lookup: (id: string) => Pick<HeldActionRecord, 'status'> | undefined
): DependencyReadiness {
  let readiness: DependencyReadiness = 'ready';
  for (const id of record.dependsOn) {
    const status = lookup(id)?.status;
    if (
      status === undefined ||
      status === 'rejected' ||
      status === 'cancelled' ||
      status === 'failed'
    ) {
      return 'dead';
    }
    if (status !== 'applied') readiness = 'wait';
  }
  return readiness;
}

/**
 * Records that must be cancelled because `root` can no longer be applied:
 * every pending or approved dependent (transitively) and anything that
 * references one of `root`'s simulated results. A dependent that already holds
 * an apply claim is left alone — its effect may be running.
 */
export function collectCascadeCancellations(
  root: Pick<HeldActionRecord, 'id' | 'simulation'>,
  candidates: readonly HeldActionRecord[]
): HeldActionRecord[] {
  const cancelled = new Set<string>([root.id]);
  const result: HeldActionRecord[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of candidates) {
      if (cancelled.has(entry.id) || entry.applyClaim) continue;
      if (entry.status !== 'pending' && entry.status !== 'approved') continue;
      const referencesProvisional =
        Boolean(entry.params) &&
        Boolean(
          root.simulation?.provisionalRefs.some((ref) => JSON.stringify(entry.params).includes(ref))
        );
      if (
        entry.dependsOn.some((dependency) => cancelled.has(dependency)) ||
        referencesProvisional
      ) {
        cancelled.add(entry.id);
        result.push(entry);
        changed = true;
      }
    }
  }
  return result;
}

export interface ReconcileActions {
  /** Mirror a decision already settled in the approval store. */
  mirror(
    record: HeldActionRecord,
    decision: 'approved' | 'rejected',
    request: { decidedBy?: string; human: boolean; authenticated: boolean }
  ): void;
  /** The request ended without a decision (cancelled / expired). */
  cancel(record: HeldActionRecord, reason: string): void;
  onError(record: HeldActionRecord, error: unknown): void;
}

/**
 * The approval store is the decision of record for a linked held action, but
 * the decision reaches the plane through a fire-and-forget bridge: if that
 * process died or the bridge failed, the held action stayed `pending` while
 * the request was already settled, and a local re-decision is refused ("already
 * decided"). This closes the gap idempotently from the request itself.
 */
export function reconcileLinkedApprovals(
  records: readonly HeldActionRecord[],
  actions: ReconcileActions
): number {
  let reconciled = 0;
  for (const record of records) {
    const link = record.approvalRequest;
    if (!link || record.status !== 'pending') continue;
    try {
      assertHeldApprovalRole(link.role);
      let request = loadApprovalRequest(link.storageChannel, link.requestId);
      if (!request) continue;
      if (request.status === 'pending' && isApprovalRequestExpired(request)) {
        request = expireApprovalRequest(HELD_APPROVAL_ROLE, {
          channel: link.storageChannel,
          storageChannel: link.storageChannel,
          requestId: link.requestId,
          reason: 'held_action_reconcile',
        });
      }
      if (request.status === 'pending') continue;
      if (request.status === 'cancelled' || request.status === 'expired') {
        actions.cancel(record, `approval request ${request.status}`);
      } else {
        const decision = request.status === 'rejected' ? 'rejected' : 'approved';
        actions.mirror(record, decision, {
          decidedBy: request.decidedBy,
          human: request.decidedByType === 'human',
          authenticated: request.authenticated === true,
        });
      }
      reconciled += 1;
    } catch (error) {
      actions.onError(record, error);
    }
  }
  return reconciled;
}

/**
 * Apply every approved action of a mission. A dependent can be ordered before
 * its dependency, so repeat while a pass applies something; deferred actions
 * (waiting on a dependency, or claimed by another process) are left for later.
 * Stops at the first failure, like the original loop.
 */
export async function drainApprovable(host: {
  list(): HeldActionRecord[];
  apply(id: string): Promise<HeldActionRecord>;
}): Promise<HeldActionRecord[]> {
  const applied: HeldActionRecord[] = [];
  for (let progressed = true; progressed;) {
    progressed = false;
    for (const record of host.list()) {
      if (record.status !== 'approved') continue;
      const outcome = await host.apply(record.id);
      if (outcome.status === 'approved') continue;
      applied.push(outcome);
      progressed = true;
      if (outcome.status === 'failed') return applied;
    }
  }
  return applied;
}

/** The effect already ran: retry a transient write failure so a claim never outlives it. */
export function persistWithRetry(write: () => void, onGiveUp: () => void, attempts = 3): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return write();
    } catch (error) {
      if (attempt >= attempts) {
        onGiveUp();
        throw error;
      }
    }
  }
}

export interface ReconcilePlane {
  listHeldActions(): HeldActionRecord[];
  decideHeldAction(
    id: string,
    decision: 'approved' | 'rejected',
    approval: HeldActionDecision & { viaApprovalRequest: boolean }
  ): unknown;
  settleCancelled(record: HeldActionRecord, reason: string): unknown;
  audit(operation: string, metadata: Record<string, unknown>): void;
}

/** Reconcile every linked held action of a plane (see reconcileLinkedApprovals). */
export function reconcilePlane(plane: ReconcilePlane): number {
  return reconcileLinkedApprovals(plane.listHeldActions(), {
    mirror: (record, decision, request) =>
      plane.decideHeldAction(record.id, decision, {
        resolvedBy: request.decidedBy || 'human:approval-store',
        decidedByType: request.human ? 'human' : 'service',
        authenticated: request.authenticated,
        payloadHash: record.payloadHash,
        effectBinding: record.effectBinding,
        viaApprovalRequest: true,
      }),
    cancel: (record, reason) => void plane.settleCancelled(record, reason),
    onError: (record, error) =>
      plane.audit('reconcile', {
        heldActionId: record.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  });
}

/**
 * Only a pending or approved action with no unresolved apply claim can be
 * cancelled: a claimed effect may have run, so its claim must be released
 * first. Also cancels the linked approval request so nothing is left pending
 * in the approval queue for an action that no longer exists.
 */
export function prepareCancellation(record: HeldActionRecord, by: string, reason: string): void {
  if (record.status !== 'pending' && record.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] Held action ${record.id} is ${record.status} and cannot be cancelled`
    );
  }
  if (record.applyClaim) {
    throw new Error(
      `[POLICY_VIOLATION] Held action ${record.id} has an apply claim; release it first (the effect may have run)`
    );
  }
  const link = record.approvalRequest;
  if (!link) return;
  assertHeldApprovalRole(link.role);
  cancelApprovalRequest(HELD_APPROVAL_ROLE, {
    channel: link.storageChannel,
    storageChannel: link.storageChannel,
    requestId: link.requestId,
    cancelledBy: by,
    reason,
  });
}

/**
 * A quarantined (tenantless) record may be adopted into a tenant only if the
 * tenant is a valid one and does not contradict the mission's own record.
 */
export function assertAdoptable(record: HeldActionRecord, tenantSlug: string): void {
  if (record.tenantSlug) {
    throw new Error(
      `[POLICY_VIOLATION] Held action ${record.id} already has a tenant (${record.tenantSlug})`
    );
  }
  if (!isValidTenantSlug(tenantSlug)) {
    throw new Error(`[POLICY_VIOLATION] '${tenantSlug}' is not a valid tenant for adoption`);
  }
  const owner = tryResolveOwnerScope({ kind: 'mission', id: record.missionId });
  if (owner && owner.tenant !== SHARED_TENANT && owner.tenant !== tenantSlug) {
    throw new Error(
      `[POLICY_VIOLATION] tenant '${tenantSlug}' contradicts the mission record (${owner.tenant})`
    );
  }
}

export interface DeclassifyHost {
  submit(input: Record<string, unknown>): HeldActionRecord;
  grants: Map<string, DeclassificationGrant>;
  audit(operation: string, metadata: Record<string, unknown>): void;
  persist(grant: DeclassificationGrant): void;
  assertHuman(value: string): string;
}

/**
 * SC-06: hash-bound declassify — a held effect that, once approved and applied,
 * lets exactly one artifact (payloadHash) egress to a declared audience/tenant
 * despite mission taint. The mission's taint itself is never lowered.
 */
export function requestDeclassify(
  host: DeclassifyHost,
  input: Omit<DeclassificationGrant, 'id' | 'grantedAt' | 'grantedBy'> & { requestedBy: string }
): HeldActionRecord {
  let record!: HeldActionRecord;
  record = host.submit({
    missionId: input.missionId,
    tenantSlug: input.tenantSlug,
    submittedBy: input.requestedBy,
    op: 'control_plane:declassify',
    params: input,
    simulatable: false,
    apply: () => {
      const grant: DeclassificationGrant = {
        ...input,
        id: randomUUID(),
        grantedBy: host.assertHuman(record.resolvedBy || ''),
        grantedAt: new Date().toISOString(),
      };
      host.grants.set(declassificationKeyOf(grant), grant);
      host.audit('grant', grant as unknown as Record<string, unknown>);
      host.persist(grant);
      return grant;
    },
  });
  return record;
}
