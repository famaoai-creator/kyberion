import { resolveRole, withExecutionContext } from '../authority.js';
import { nowIso } from '../foundation/time.js';
import { enforceNhiActorPolicy } from '../nhi-actor-verification.js';
import { WorkCoordinationError, assertWorkClaimsAllowed } from './work-coordination-error.js';
import { workEffectOwnership } from './work-effect-ownership.js';
import type { LedgerEntry } from '../governance/accountability-charter-registry.js';
import type {
  WorkItem,
  WorkLease,
  WorkItemAttempt,
  WorkCoordinationEventType,
} from './work-coordination-types.js';

interface PipelineContinuationStore {
  withCoordinationMutation<T>(fn: () => T): T;
  currentWorkItem(id: string): WorkItem | null;
  activeLeaseForItem(id: string): WorkLease | null;
  currentLeaseById(id: string): WorkLease | null;
  appendLeaseSnapshot(lease: WorkLease): WorkLease;
  appendItemSnapshot(item: WorkItem): WorkItem;
  appendLeaseEvent(
    type: WorkCoordinationEventType,
    id: string,
    lease: WorkLease,
    note: string,
    actor?: string
  ): void;
  appendWorkItemAttemptEvent(
    type: WorkCoordinationEventType,
    id: string,
    attempt: WorkItemAttempt | null,
    note: string,
    actor?: string
  ): void;
  randomId(prefix: string): string;
}

export interface ResumeSuspendedPipelineWorkItemInput {
  itemId: string;
  runId: string;
  approvalRequestId: string;
  storageChannel: string;
  actorPeerId: string;
  expectedAttemptId: string;
  tenantSlug: string;
  sourceHash: string;
  ttlMs?: number;
}

export async function continueSuspendedPipelineWorkItem(
  input: ResumeSuspendedPipelineWorkItemInput,
  action: 'resume' | 'deny',
  store: PipelineContinuationStore
): Promise<{ item: WorkItem; lease?: WorkLease }> {
  const {
    withCoordinationMutation,
    currentWorkItem,
    activeLeaseForItem,
    currentLeaseById,
    appendLeaseSnapshot,
    appendItemSnapshot,
    appendLeaseEvent,
    appendWorkItemAttemptEvent,
    randomId,
  } = store;
  // The store fence assumes infrastructure_sentinel for its own files. A
  // protected source journal is read under the caller's original authority,
  // never by broadening the sentinel's permissions or inventing a role.
  const journalReaderRole = resolveRole();
  const [
    { loadPipelineRunJournal },
    { loadApprovalRequest },
    { assertApprovalUsable },
    registry,
    scopes,
  ] = await Promise.all([
    import('../pipeline/pipeline-run-journal.js'),
    import('../governance/approval-store-reader.js'),
    import('../governance/approval-separation-of-duties.js'),
    import('../governance/accountability-charter-registry.js'),
    import('../scope-envelope.js'),
  ]);
  const boundTenant =
    scopes.currentScopeEnvelope()?.identity.tenant_slug ??
    scopes.runtimeScopeIdentity().tenant_slug;
  return withCoordinationMutation(() => {
    const deny = (reason: string): never => {
      throw new WorkCoordinationError(
        'validation_error',
        `[PIPELINE_CONTINUATION_DENIED] ${reason}`
      );
    };
    assertWorkClaimsAllowed(input.itemId);
    if (boundTenant && boundTenant !== input.tenantSlug)
      deny('caller tenant differs from suspended work item');
    const item = currentWorkItem(input.itemId);
    if (
      !item ||
      !['blocked', 'in_progress'].includes(item.status) ||
      item.context?.tenant_slug !== input.tenantSlug
    )
      deny('work item is not suspended in this tenant');
    const current = item!;
    const attempt = current.attempts?.at(-1);
    if (
      !attempt ||
      attempt.run_id !== input.expectedAttemptId ||
      (current.current_attempt_id && current.current_attempt_id !== attempt.run_id)
    )
      deny('original attempt changed');
    const original = attempt!;
    const hold = workEffectOwnership(current);
    if (
      !hold ||
      hold.state !== 'held' ||
      hold.attempt_id !== original.run_id ||
      hold.tenant_slug !== input.tenantSlug ||
      hold.actor_id !== input.actorPeerId ||
      original.actor_peer_id !== input.actorPeerId
    )
      deny('original effect ownership is not held by this runner');
    const pending = current.metadata?.dot_executor as Record<string, unknown> | undefined;
    if (
      !pending ||
      pending.mode !== 'pipeline' ||
      pending.awaiting_approval !== true ||
      pending.pipeline_run_id !== input.runId ||
      pending.approval_request_id !== input.approvalRequestId ||
      pending.storage_channel !== input.storageChannel
    )
      deny('suspension handoff changed');
    const approval = loadApprovalRequest(input.storageChannel, input.approvalRequestId);
    if (
      !approval ||
      (action === 'resume'
        ? approval.status !== 'approved' || approval.decidedByType !== 'human'
        : !['rejected', 'cancelled', 'expired'].includes(approval.status) ||
          (approval.status === 'rejected' && approval.decidedByType !== 'human') ||
          (approval.status === 'expired' &&
            (!approval.expiresAt ||
              !Number.isFinite(Date.parse(approval.expiresAt)) ||
              Date.parse(approval.expiresAt) > Date.now()))) ||
      approval.scope?.tenant_slug !== input.tenantSlug ||
      approval.applyClaim ||
      approval.applyResult ||
      approval.requestedByContext?.pipelineRunId !== input.runId ||
      !approval.requestedByContext.executionBindingHash ||
      approval.accountability?.finalDecision !== 'human_only' ||
      approval.accountability.payloadHash !== approval.requestedByContext.executionBindingHash
    )
      deny('exact human approval unavailable');
    if (action === 'resume')
      assertApprovalUsable(approval!, { consumer: 'pipeline_work_item_continuation' });
    const tier = approval!.scope?.tier;
    if (tier !== 'public' && tier !== 'confidential' && tier !== 'personal')
      deny('protected journal tier missing');
    const readJournal = () =>
      loadPipelineRunJournal(input.runId, undefined, {
        tier: tier!,
        tenantSlug: input.tenantSlug,
      });
    const journal = journalReaderRole
      ? withExecutionContext(journalReaderRole, readJournal)
      : readJournal();
    const snapshot = journal.started?.library_execution;
    const suspension = journal.suspended;
    if (
      !snapshot ||
      snapshot.work_item?.id !== current.item_id ||
      snapshot.work_item.tenantSlug !== input.tenantSlug ||
      snapshot.work_item.agentId !== input.actorPeerId ||
      snapshot.work_item.attemptId !== original.run_id ||
      snapshot.payload_scope.tenant_slug !== input.tenantSlug ||
      snapshot.payload_scope.tier !== tier ||
      snapshot.source_sha256 !== input.sourceHash ||
      !/^[a-f0-9]{64}$/.test(input.sourceHash) ||
      !suspension ||
      suspension.approval_request_id !== input.approvalRequestId ||
      suspension.storage_channel !== input.storageChannel ||
      suspension.execution_binding_hash !== approval!.requestedByContext!.executionBindingHash ||
      approval!.requestedByContext!.targetStepId !== suspension.step_id ||
      journal.completed_nodes.has(suspension.step_id) ||
      (action === 'resume' ? Boolean(journal.finished) : journal.finished?.status !== 'aborted')
    )
      deny('protected original pipeline snapshot does not match');

    // A crash/timeout after submission is not evidence of non-execution. Even
    // an approved request cannot reopen a claimed or uncertain business effect.
    const tenantScope = { kind: 'organization', tenant_slug: input.tenantSlug } as const;
    const scanEffects = () => {
      for (const charterId of registry.listCharterIds(tenantScope)) {
        const charter = registry.readCharter(tenantScope, charterId)!;
        const states = new Map<string, Extract<LedgerEntry, { kind: 'delegated_execution' }>>();
        for (const entry of registry.readCharterLedger(charter)) {
          if (entry.kind === 'delegated_execution' && entry.source?.workItemId === current.item_id)
            states.set(entry.permit_id, entry);
        }
        if (
          [...states.values()].some(
            (entry) => entry.state === 'executing' || entry.state === 'unknown'
          )
        )
          deny('a prior effect requires authoritative reconciliation');
      }
    };
    if (journalReaderRole) withExecutionContext(journalReaderRole, scanEffects);
    else scanEffects();
    if (activeLeaseForItem(current.item_id)) deny('a live runner still owns this work item');
    enforceNhiActorPolicy(input.actorPeerId, 'work-coordination.resumeSuspendedPipelineWorkItem');
    const now = nowIso();
    const oldLease = original.lease_id ? currentLeaseById(original.lease_id) : null;
    if (
      !oldLease ||
      oldLease.item_id !== current.item_id ||
      oldLease.holder_peer_id !== input.actorPeerId
    )
      deny('original scheduling lease missing');
    if (oldLease!.status === 'active')
      appendLeaseSnapshot({ ...oldLease!, status: 'expired', released_at: now });
    if (action === 'deny') {
      const deniedAttempt: WorkItemAttempt = {
        ...original,
        status: 'blocked',
        ended_at: now,
        blocked_reason: `pipeline ${approval!.status}; execution aborted`,
        metadata: {
          ...original.metadata,
          pipeline_abort: {
            run_id: input.runId,
            approval_request_id: input.approvalRequestId,
            journal: journal.path,
            source_sha256: input.sourceHash,
          },
        },
      };
      const deniedItem = appendItemSnapshot({
        ...current,
        status: 'archived',
        version: current.version + 1,
        updated_at: now,
        lease_id: undefined,
        claimed_at: undefined,
        released_at: now,
        claimed_by_peer_id: undefined,
        current_attempt_id: undefined,
        attempts: [...current.attempts!.slice(0, -1), deniedAttempt],
        effect_ownership: {
          ...hold!,
          state: 'settled',
          settled_at: now,
          settlement: 'execution_aborted',
          settlement_evidence_ref: journal.path,
        },
        metadata: {
          ...current.metadata,
          dot_executor: {
            ...pending,
            status: 'denied',
            awaiting_approval: false,
            reason_code: `pipeline_${approval!.status}`,
            verified_terminal_journal: journal.path,
          },
        },
      });
      appendWorkItemAttemptEvent(
        'item_attempt_blocked',
        current.item_id,
        deniedAttempt,
        'original rejected pipeline terminated with protected journal evidence',
        input.actorPeerId
      );
      return { item: deniedItem };
    }
    const lease: WorkLease = {
      lease_id: randomId('wlease'),
      item_id: current.item_id,
      holder_peer_id: input.actorPeerId,
      purpose: 'resume original approved pipeline',
      status: 'active',
      expires_at: new Date(
        Date.now() + Math.min(Math.max(input.ttlMs ?? 900000, 1000), 900000)
      ).toISOString(),
      created_at: now,
      renewed_at: now,
      previous_lease_id: oldLease!.lease_id,
      idempotency_key: `pipeline-continuation:${input.runId}:${input.approvalRequestId}:${original.run_id}`,
    };
    appendLeaseSnapshot(lease);
    const resumedAttempt: WorkItemAttempt = {
      ...original,
      status: 'running',
      lease_id: lease.lease_id,
      ended_at: undefined,
      blocked_reason: undefined,
      metadata: {
        ...original.metadata,
        pipeline_resume: {
          run_id: input.runId,
          approval_request_id: input.approvalRequestId,
          source_sha256: input.sourceHash,
          resumed_at: now,
        },
      },
    };
    const next = appendItemSnapshot({
      ...current,
      status: 'in_progress',
      version: current.version + 1,
      updated_at: now,
      lease_id: lease.lease_id,
      claimed_at: now,
      released_at: undefined,
      claimed_by_peer_id: input.actorPeerId,
      current_attempt_id: original.run_id,
      attempts: [...current.attempts!.slice(0, -1), resumedAttempt],
      effect_ownership: hold,
    });
    appendLeaseEvent(
      'item_claimed',
      current.item_id,
      lease,
      'continued original approved pipeline attempt',
      input.actorPeerId
    );
    appendWorkItemAttemptEvent(
      'item_attempt_started',
      current.item_id,
      resumedAttempt,
      'same attempt resumed after exact human authorization',
      input.actorPeerId
    );
    return { item: next, lease };
  });
}
