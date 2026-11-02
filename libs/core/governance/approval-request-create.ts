/** Request creation only: cannot resolve decisions or dispatch mission steering. */
import { randomUUID } from 'node:crypto';
import { normalizeApprovalChannel } from './approval-store-paths.js';
import {
  setApprovalChannelWarner,
  warnUndeclaredApprovalChannel,
} from '../foundation/approval-domains.js';
import {
  subjectAuthorization,
  type SubjectAuthorization,
} from '../foundation/authorization-registry.js';
import { createLogger } from '../logger.js';
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

// P2 measurement: route undeclared-channel diagnostics through the shared
// logger. Registered once here; the dedupe set lives in approval-domains.
const approvalChannelLogger = createLogger('approval-request-create');
setApprovalChannelWarner((message) => approvalChannelLogger.warn(message));

export function createApprovalRequest(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    /**
     * Unified authorization subject for this approval
     * (`op`-shaped ids or `intent:`/`capability:`/`verb:`-prefixed subjects).
     * When the subject's declaration carries `approvalDomain` — or its
     * authority is external admission (whose approvals land in the
     * `external-operation` domain) — it supplies `storageChannel` when the
     * caller did not pass one, and warns on a mismatch (measurement-first:
     * the caller's value is kept). Bridges register with the owning policy
     * module (approval-policy.ts for `intent:` subjects, …).
     */
    subject?: string;
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
  // Measurement-only (P2): undeclared channel vocabulary is logged, never
  // blocked. Emitted before normalizeApprovalChannel so values that would
  // fail syntax validation are still measured. `channel` in the surface
  // position may legitimately hold a declared domain (the historical
  // domain-as-channel pattern), so only truly undeclared values warn.
  if (typeof params.channel === 'string') {
    warnUndeclaredApprovalChannel('channel', params.channel);
  }
  if (typeof params.storageChannel === 'string') {
    warnUndeclaredApprovalChannel('storageChannel', params.storageChannel);
  }
  // Subject-derived routing: the declaration supplies the storage domain when
  // the call site did not pick one; a conflicting explicit value is kept but
  // measured (rollout is warn-only, never silently rewired). Only DECLARED
  // subjects derive — an undeclared subject resolves to the external fail-safe
  // for authority purposes, but it must not repartition storage into a domain
  // it never proved it belongs to.
  let declaredDomain: string | undefined;
  if (typeof params.subject === 'string' && params.subject) {
    const resolved = subjectAuthorization(params.subject);
    declaredDomain = resolved.declared
      ? (resolved.approvalDomain ??
        (resolved.authority.kind === 'admission' && resolved.authority.boundary === 'external'
          ? 'external-operation'
          : undefined))
      : undefined;
    if (!resolved.declared) {
      approvalChannelLogger.warn(
        `undeclared approval subject '${params.subject}' — declare it in the authorization registry or its detail layer (intent/capability/verb)`
      );
    }
    if (
      declaredDomain &&
      typeof params.storageChannel === 'string' &&
      params.storageChannel !== declaredDomain
    ) {
      approvalChannelLogger.warn(
        `approval subject '${params.subject}' declares domain '${declaredDomain}' but call site passed storageChannel '${params.storageChannel}' — keeping caller value`
      );
    }
  }
  const storageChannel = normalizeApprovalChannel(
    params.storageChannel || declaredDomain || params.channel
  );
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
    ...(params.subject ? { subject: params.subject } : {}),
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
 * Internal-admission twin of `admitExternalOperation` (external-operation.ts):
 * the typed entry point for approval-producing internal decisions. The subject
 * is resolved once through the unified authorization registry and threaded to
 * `createApprovalRequest`, which derives the storage domain from the
 * declaration instead of a call-site literal. Returns the resolved
 * authorization so callers can branch on the declared authority
 * (assurance floor, dual-key) without a second lookup.
 */
export function admitInternalDecision(
  role: GovernedArtifactRole,
  params: Parameters<typeof createApprovalRequest>[1] & { subject: string }
): { record: ApprovalRequestRecord; authorization: SubjectAuthorization } {
  const authorization = subjectAuthorization(params.subject);
  const record = createApprovalRequest(role, params);
  return { record, authorization };
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
