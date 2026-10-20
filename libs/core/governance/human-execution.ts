import { AsyncLocalStorage } from 'node:async_hooks';
import { loadApprovalRequest, isApprovalRequestExpired } from './approval-store-reader.js';
import { claimApprovalApply } from './approval-apply-claim.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { assertApprovalUsable } from './approval-separation-of-duties.js';
import { validateHumanFinalDecision } from './approval-human-decision.js';
import {
  delegatedExecutionBindingHash,
  delegatedExecutionIdentity,
  isDelegatedExecutionReplayBlocked,
  normalizeDelegatedTarget,
  type DelegatedExecutionTarget,
} from './delegated-execution.js';
import { assertNoHumanClaim, withExecutionIdentityLock } from './execution-claim-fence.js';

export interface HumanExecutionReference {
  channel: string;
  requestId: string;
  claimId: string;
}
const execution = new AsyncLocalStorage<{
  target: DelegatedExecutionTarget;
  reference: HumanExecutionReference;
}>();

export function assertHumanExecutionNotPreviouslyClaimed(target: DelegatedExecutionTarget): void {
  assertNoHumanClaim(delegatedExecutionIdentity(target), target.tenantSlug);
}

/** Serialize all approval-request claims for the same durable task effect slot. */
export function claimHumanExecutionAuthorization(
  target: DelegatedExecutionTarget,
  reference: Pick<HumanExecutionReference, 'channel' | 'requestId'>
) {
  return withExecutionIdentityLock(delegatedExecutionIdentity(target), () => {
    if (isDelegatedExecutionReplayBlocked(target))
      throw new Error('[HUMAN_EXECUTION_RECONCILIATION_REQUIRED] Delegated effect already claimed');
    assertHumanExecutionNotPreviouslyClaimed(target);
    const record = loadApprovalRequest(reference.channel, reference.requestId);
    if (
      !record ||
      record.requestedByContext?.executionIdentity !== delegatedExecutionIdentity(target) ||
      record.requestedByContext.executionBindingHash !== delegatedExecutionBindingHash(target)
    ) {
      throw new Error('[HUMAN_EXECUTION_DENIED] Exact stable execution identity required');
    }
    return claimApprovalApply('mission_controller', {
      channel: reference.channel,
      requestId: record.id,
      appliedBy: target.agentId,
      expectedRecordHash: computeApprovalPayloadHash({ record }),
    });
  });
}

function verify(target: DelegatedExecutionTarget, reference: HumanExecutionReference): boolean {
  try {
    const record = loadApprovalRequest(reference.channel, reference.requestId);
    if (
      !record ||
      record.status !== 'approved' ||
      record.applyResult ||
      isApprovalRequestExpired(record) ||
      record.applyClaim?.claimId !== reference.claimId ||
      record.scope?.tenant_slug !== target.tenantSlug ||
      record.requestedByContext?.executionBindingHash !== delegatedExecutionBindingHash(target) ||
      record.accountability?.finalDecision !== 'human_only' ||
      record.accountability.payloadHash !== delegatedExecutionBindingHash(target)
    )
      return false;
    assertApprovalUsable(record, { consumer: 'human_execution_transport' });
    validateHumanFinalDecision({
      accountability: record.accountability,
      decidedByType: record.decidedByType,
      authenticated: record.authenticated,
      authMethod: record.decidedAuthMethod,
      payloadHash: record.accountability.payloadHash,
      effectBinding: record.accountability.effectBinding,
      mode: 'enforce',
      channel: record.channel,
    });
    return true;
  } catch {
    return false;
  }
}

/** Separate human provenance; no charter permit or context-shaped approval is fabricated. */
export function currentHumanExecutionAuthorization(
  operationId: string,
  params: Record<string, unknown>
):
  | {
      target: DelegatedExecutionTarget;
      reference: HumanExecutionReference;
    }
  | undefined {
  const active = execution.getStore();
  if (!active) return;
  const actual = normalizeDelegatedTarget({ ...active.target, operationId, params });
  if (
    delegatedExecutionBindingHash(actual) !== delegatedExecutionBindingHash(active.target) ||
    !verify(active.target, active.reference)
  )
    return;
  return active;
}

export function hasHumanExecutionContext(): boolean {
  return Boolean(execution.getStore());
}

/** Called only after the existing approval store publishes its durable once-only apply claim. */
export async function runHumanExecutionAuthorization<T>(
  target: DelegatedExecutionTarget,
  reference: HumanExecutionReference,
  effect: () => Promise<T>
): Promise<T> {
  const normalized = normalizeDelegatedTarget(target);
  if (!verify(normalized, reference))
    throw new Error('[HUMAN_EXECUTION_DENIED] Exact current approval and apply claim required');
  return execution.run({ target: normalized, reference }, effect);
}
