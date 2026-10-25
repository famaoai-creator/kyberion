/** Request creation only: cannot resolve decisions or dispatch mission steering. */
import { randomUUID } from 'node:crypto';
import { normalizeApprovalChannel } from './approval-store-paths.js';
import {
  appendLocatedApprovalEvent,
  approvalPartitionForScope,
  approvalRequestsLogicalDirAt,
  ensureApprovalDirAt,
  writeLocatedApprovalRequest,
} from './approval-store-location.js';
import type { GovernedArtifactRole } from '../workforce/artifact-store.js';
import { nowIso } from '../foundation/time.js';
import { validateDecisionCard, type DecisionCard } from './decision-card.js';
import { normalizeEventScope, type EventScopeInput } from '../event-scope.js';
import { withDefaultMinAssurance } from './approval-human-decision.js';
import {
  buildOrganizationWorkLoopSummary,
  type OrganizationWorkLoopSummary,
} from '../workforce/work-design.js';
import {
  getDefaultWorkerEventStream,
  type WorkerEventPayloadMap,
  type WorkerEventSource,
} from '../workforce/worker-event-stream.js';
import type { ApprovalVetoWindow } from './approval-veto-window.js';
import type {
  ApprovalRequestDraft,
  ApprovalRequestRecord,
  ApprovalRequesterContext,
  ApprovalTargetDescriptor,
  ApprovalJustification,
  ApprovalRiskProfile,
  ApprovalWorkflowState,
  ApprovalAccountability,
  ApprovalRequestSource,
  ApprovalSteeringAction,
} from './approval-store.js';

/** System-tree event log of a channel (tenant partitions: approval-store-location.ts). */
export { approvalEventLogicalPath } from './approval-store-paths.js';

export function createApprovalRequest(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    threadTs: string;
    correlationId: string;
    requestedBy: string;
    /** Display name of the requester (see `cli-operator-principal.ts`). */
    requestedByDisplayName?: string;
    draft: ApprovalRequestDraft;
    sourceText?: string;
    kind?: ApprovalRequestRecord['kind'];
    expiresAt?: string;
    requestedByContext?: ApprovalRequesterContext;
    target?: ApprovalTargetDescriptor;
    justification?: ApprovalJustification;
    risk?: ApprovalRiskProfile;
    workflow?: ApprovalWorkflowState;
    trackId?: string;
    trackName?: string;
    workLoop?: OrganizationWorkLoopSummary;
    accountability?: ApprovalAccountability;
    source?: ApprovalRequestSource;
    steering?: ApprovalSteeringAction;
    scope?: EventScopeInput;
    decisionCard?: DecisionCard;
    veto?: ApprovalVetoWindow;
    /**
     * Only for a genuine tenant-activation request (`tenant-activation`
     * storage channel and kind `mission_gate`): the scope's tenant is already
     * active (organization/tenant-activation.ts isTenantActivationActive). An
     * activation request for a tenant that is not yet active stays in the
     * system tree; every other tenant-scoped request goes to the tenant's
     * partition (approval-store-location.ts approvalPartitionForScope).
     */
    tenantActive?: boolean;
  }
): ApprovalRequestRecord {
  if (params.decisionCard) validateDecisionCard(params.decisionCard);
  if (params.veto && params.accountability?.finalDecision === 'human_only') {
    throw new Error(
      '[POLICY_VIOLATION] A veto-window request cannot also require a human-only final decision'
    );
  }
  const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
  const scope = params.scope ? normalizeEventScope(params.scope) : undefined;
  const located = {
    partition: approvalPartitionForScope(scope, {
      storageChannel,
      kind: params.kind || 'channel-approval',
      tenantActive: params.tenantActive,
    }),
    storageChannel,
  };
  // Refuses a tenant this process may not bind before anything is written.
  ensureApprovalDirAt(
    role,
    located.partition,
    approvalRequestsLogicalDirAt(located.partition, storageChannel)
  );

  const record: ApprovalRequestRecord = {
    id: randomUUID(),
    kind: params.kind || 'channel-approval',
    storageChannel,
    channel: params.channel,
    threadTs: params.threadTs,
    correlationId: params.correlationId,
    requestedBy: params.requestedBy,
    ...(params.requestedByDisplayName
      ? { requestedByDisplayName: params.requestedByDisplayName }
      : {}),
    requestedAt: nowIso(),
    status: 'pending',
    title: params.draft.title,
    summary: params.draft.summary,
    details: params.draft.details,
    severity: params.draft.severity || 'medium',
    sourceText: params.sourceText,
    source: params.source,
    expiresAt: params.expiresAt,
    requestedByContext: params.requestedByContext,
    target: params.target,
    justification: params.justification,
    risk: params.risk,
    workflow: params.workflow,
    track_id: params.trackId,
    track_name: params.trackName,
    work_loop:
      params.workLoop ||
      buildOrganizationWorkLoopSummary({
        intentId: 'approval-request',
        shape: 'task_session',
        outcomeIds: ['approval_request'],
        requiresApproval: true,
      }),
    accountability: withDefaultMinAssurance(params.accountability),
    steering: params.steering,
    ...(scope ? { scope } : {}),
    ...(params.decisionCard ? { decisionCard: params.decisionCard } : {}),
    ...(params.veto ? { veto: params.veto } : {}),
  };

  writeLocatedApprovalRequest(role, located, record);
  appendLocatedApprovalEvent(role, located, {
    ts: nowIso(),
    event: 'approval_requested',
    request_id: record.id,
    correlation_id: record.correlationId,
    requested_by: record.requestedBy,
    source: record.source,
    scope: record.scope,
    channel: record.channel,
    thread_ts: record.threadTs,
  });
  projectApprovalWorkerEvent(
    'approval_request',
    {
      request_id: record.id,
      correlation_id: record.correlationId,
      requested_by: record.requestedBy,
      channel: record.channel,
      status: 'pending',
      title: record.title,
      summary: record.summary,
      severity: record.severity || 'medium',
      kind: record.kind,
      ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
    },
    approvalWorkerEventSource(record)
  );
  return record;
}

/**
 * KC-02: project approval lifecycle onto the worker event stream so every
 * surface renders the same approval dialog from one contract. The jsonl
 * event log above stays the SSoT; this projection is best-effort.
 */
export function projectApprovalWorkerEvent<K extends 'approval_request' | 'approval_response'>(
  type: K,
  payload: WorkerEventPayloadMap[K],
  source?: WorkerEventSource
): void {
  try {
    getDefaultWorkerEventStream().emit(type, payload, source);
  } catch {
    /* never let observability break the approval path */
  }
}

export function approvalWorkerEventSource(record: ApprovalRequestRecord): WorkerEventSource {
  return {
    ...(record.source?.missionId ? { mission_id: record.source.missionId } : {}),
    ...(record.source?.taskId ? { task_id: record.source.taskId } : {}),
    agent_id: record.source?.agentId || record.requestedBy,
  };
}
