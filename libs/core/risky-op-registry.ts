/**
 * Risky Op Registry — thin wrapper around enforceApprovalGate that lets
 * callers invoke governance on a named operation without threading
 * intent_id / correlation_id boilerplate through every call site.
 *
 * Implements CONCEPT_INTEGRATION_BACKLOG P2-6 at the call-site ergonomics
 * layer. The authoritative approval rules live in
 * knowledge/product/governance/approval-policy.json; this module only
 * adds a minimal dispatcher plus stable op IDs that downstream code can
 * reference from a single place.
 */

import { requireApprovalForOp } from './risky-op-approval-implementation.js';
import { registerRiskyApprovalHandler } from './risky-op-approval-port.js';
import { RISKY_OPS, type RiskyOpId } from './risky-op-ids.js';

export { RISKY_OPS, type RiskyOpId } from './risky-op-ids.js';

export type { RequireApprovalParams } from './risky-op-approval-implementation.js';

/**
 * Gate a risky operation. Returns the approval decision; callers must
 * short-circuit on `result.allowed === false`. The canonical usage is:
 *
 * ```ts
 * const approval = requireApprovalForOp({
 *   opId: RISKY_OPS.SECRET_GRANT_ACCESS,
 *   agentId: 'mission_controller',
 *   payload: { missionId, serviceId, ttlMinutes },
 * });
 * if (!approval.allowed) throw new Error(approval.message ?? 'approval required');
 * ```
 *
 * The underlying policy evaluation reads approval-policy.json via
 * resolveApprovalPolicy. Ops not listed there fall through with
 * requires_approval=false.
 */
export { requireApprovalForOp } from './risky-op-approval-implementation.js';

/** Whether an op id is one the registry explicitly recognises. */
export function isKnownRiskyOp(opId: string): opId is RiskyOpId {
  return (Object.values(RISKY_OPS) as string[]).includes(opId);
}

registerRiskyApprovalHandler(requireApprovalForOp);
