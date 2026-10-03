import type { ApprovalRequestRecord } from './approval-store.js';
import type { GovernedArtifactRole } from '../workforce/artifact-store.js';
import type { SurfaceAsyncChannel } from '../surface/channel-surface-types.js';

/**
 * SC-04: surface context for routing a held action's decision through the
 * shared approval store. Absent, the held action stays on the
 * control-plane-local decision path (compat shim).
 */
export interface HeldActionSteeringSpec {
  surface: SurfaceAsyncChannel;
  channel: string;
  threadTs: string;
  storageChannel?: string;
  correlationId: string;
  requestedBy: string;
  title: string;
  summary: string;
}

/** The linked approval-store request — decision of record lives there. */
export interface HeldActionApprovalLink {
  requestId: string;
  storageChannel: string;
  role: GovernedArtifactRole;
}

/**
 * SC-04: a cloudflare-os held action whose decision travels the shared
 * approval path. Deciding the request settles the held action through
 * {@link settleHeldEffectDecision}; applying the effect still belongs to
 * the owner process's executor registry — the request only carries the
 * hash-bound authorization, never the executable.
 */
export interface HeldEffectSteeringAction {
  kind: 'held_effect';
  heldActionId: string;
  op: string;
  effectBinding: string;
  payloadHash: string;
  missionId: string;
  tenantSlug?: string;
  note?: string;
  surface: SurfaceAsyncChannel;
  channel: string;
  threadTs: string;
  correlationId: string;
}

/**
 * SC-04: propagate an approval-store decision to the cloudflare-os held
 * action it steers. The request record is the authority; this writes the
 * mirrored decision into the control-plane journal so the owner process —
 * where executors live — picks it up on journal catch-up and applies.
 *
 * Kept in its own module and always imported dynamically: approval-store
 * must not statically depend on the control plane.
 */
export async function settleHeldEffectDecision(
  record: ApprovalRequestRecord,
  decision: 'approved' | 'rejected'
): Promise<void> {
  const steering = record.steering;
  if (!steering || steering.kind !== 'held_effect') {
    throw new Error(
      `[held-effect-bridge] approval ${record.id} is not a held-effect steering request`
    );
  }
  // The shared instance keeps the bridge aligned with the caller's plane
  // and picks up journal catch-up for cross-process decisions.
  const { sharedControlPlane } = await import('../cloudflare-os-shared.js');
  const controlPlane = sharedControlPlane();
  controlPlane.decideHeldAction(steering.heldActionId, decision, {
    resolvedBy: record.decidedBy || 'human:approval-store',
    decidedByType: record.decidedByType === 'human' ? 'human' : 'service',
    authenticated: record.authenticated === true,
    payloadHash: steering.payloadHash,
    effectBinding: steering.effectBinding,
    viaApprovalRequest: true,
  });
}
