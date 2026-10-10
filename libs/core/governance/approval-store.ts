import { randomUUID } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { withLockSync } from '../lock-utils.js';
import type { FirstJobDecisionProof } from '../surface/first-job-approval-proof.js';
import { auditChain } from './audit-chain.js';
import { resolveSeparationOfDutiesPolicy } from './approval-policy.js';
import {
  assertApprovalUsable,
  auditSeparationOfDutiesRefusal,
  evaluateSeparationOfDuties,
  SEPARATION_OF_DUTIES_MESSAGES,
  type ApprovalDeciderIdentitySource,
} from './approval-separation-of-duties.js';
import type { HeldEffectSteeringAction } from './held-effect-bridge.js';
import type { ApprovalConsumption, ApprovalRevocation } from './approval-revocation.js';
import {
  bindPresentedDecision,
  refuseHumanOnlyDecisionByAgentProcess,
  reportAssuranceShortfall,
  settlePasskeyDecisionProof,
  settleUnpresentedHumanDecision,
  validateHumanFinalDecision,
  withDefaultMinAssurance,
  type ApprovalDeciderPrincipal,
} from './approval-human-decision.js';
export { validateHumanFinalDecision } from './approval-human-decision.js';
import type * as assurance from './approval-assurance.js';
export * from './approval-assurance.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
export * from './approval-presentation.js';
import {
  appendGovernedArtifactJsonl,
  ensureGovernedArtifactDir,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from '../workforce/artifact-store.js';
import { pathResolver } from '../path-resolver.js';
import { nowIso } from '../foundation/time.js';
import { approvalStoreRoots } from './approval-store-paths.js';
import type { RejectionReasonCategory } from '../rejection-reason.js';
import type { SurfaceAsyncChannel } from '../surface/channel-surface-types.js';
import { validateDecisionCard, type DecisionCard } from './decision-card.js';
import type { ApprovalVetoWindow } from './approval-veto-window.js';
import {
  eventScopeMatches,
  normalizeEventScope,
  type EventScope,
  type EventScopeInput,
} from '../event-scope.js';
import { safeExistsSync, safeFsyncFile, safeReaddir } from '../secure-io.js';
import {
  getDefaultWorkerEventStream,
  type WorkerEventPayloadMap,
  type WorkerEventSource,
} from '../workforce/worker-event-stream.js';
import {
  buildOrganizationWorkLoopSummary,
  type OrganizationWorkLoopSummary,
} from '../workforce/work-design.js';

const APPROVAL_CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const APPROVAL_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeApprovalChannel(channel: string, label = 'channel'): string {
  const normalized = String(channel || '')
    .trim()
    .toLowerCase();
  if (!normalized || !APPROVAL_CHANNEL_PATTERN.test(normalized)) {
    throw new Error(`[POLICY_VIOLATION] Invalid approval ${label}: ${channel}`);
  }
  return normalized;
}

function normalizeApprovalRequestId(id: string): string {
  const normalized = String(id || '').trim();
  if (!normalized || !APPROVAL_REQUEST_ID_PATTERN.test(normalized)) {
    throw new Error(`[POLICY_VIOLATION] Invalid approval request id: ${id}`);
  }
  return normalized.toLowerCase();
}

export interface ApprovalRequestDraft {
  title: string;
  summary: string;
  details?: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface ApprovalRequesterContext {
  /**
   * MO-11 S-2: `brief` is the mission-brief HTML surface (report-review). It is
   * a distinct value rather than an alias of `presence` because the origin of
   * an approval is primary audit evidence — a decision taken in presence-studio
   * must stay distinguishable from one taken in a brief review session.
   */
  surface: 'slack' | 'chronos' | 'terminal' | 'presence' | 'brief' | 'api' | 'system';
  actorId: string;
  actorRole: string;
  missionId?: string;
  runtimeId?: string;
  /** Pipeline control step that created the request. */
  stepId?: string;
  /** Effect step this approval is explicitly bound to. */
  targetStepId?: string;
  /** Durable pipeline run that must be resumed after this approval. */
  pipelineRunId?: string;
}

export interface ApprovalTargetDescriptor {
  serviceId: string;
  secretKey: string;
  mutation: 'set' | 'rotate' | 'delete' | 'refresh' | 'metadata_update';
  store?: 'os_keychain' | 'connection_document' | 'vault';
  newValueFingerprint?: string;
  existingValuePresent?: boolean;
}

export interface ApprovalJustification {
  reason: string;
  impactSummary?: string;
  evidence?: string[];
  requestedEffects?: string[];
}

export interface ApprovalRiskProfile {
  level: 'low' | 'medium' | 'high' | 'critical';
  restartScope: 'none' | 'runtime' | 'surface' | 'service' | 'manual';
  requiresStrongAuth: boolean;
  policyId?: string;
}

export interface ApprovalStage {
  stageId: string;
  requiredRoles: string[];
  description?: string;
}

export interface ApprovalRecord {
  role: string;
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
  approvedBy?: string;
  approvedAt?: string;
  /**
   * MO-11 S-3: `local_token` = a loopback-bound page gated by a per-launch
   * token (the mission-brief surface). It proves possession of a locally
   * printed token, not identity — recorded distinctly so audits can tell it
   * apart from a real session (HA-03: its assurance level, `approval-assurance.ts`).
   */
  authMethod?: assurance.ApprovalAuthMethod;
  note?: string;
  /** LC-10: closed-vocabulary rejection reason (see rejection-reason.ts). */
  reasonCategory?: RejectionReasonCategory;
  decidedByType?: 'human' | 'ai_agent' | 'service';
  authenticated?: boolean;
  payloadHash?: string;
  effectBinding?: string;
  /** How the surface obtained `approvedBy` (see ApprovalDeciderIdentitySource). */
  deciderIdentitySource?: ApprovalDeciderIdentitySource;
}

export interface ApprovalAccountability {
  /** Final accountability is held by a human principal, never an agent/service. */
  finalDecision: 'human_only';
  /**
   * HA-03: the weakest decider proof that may settle this request. Set on
   * creation (A2, or A3 for dual-key); a record without it is read as A2.
   */
  min_assurance?: assurance.ApprovalAssuranceLevel;
  /** The approval-policy rule that required the request (decision-time floor, HA-08). */
  policy_rule_id?: string;
  payloadHash?: string;
  effectBinding?: string;
}

export interface ApprovalWorkflowState {
  workflowId: string;
  mode: 'all_required' | 'any_of' | 'staged';
  requiredRoles: string[];
  currentStage?: string;
  stages: ApprovalStage[];
  approvals: ApprovalRecord[];
}

/** Durable at-most-once fence; an interrupted attempt requires explicit operator recovery. */
export interface ApprovalApplyClaim {
  claimId: string;
  startedAt: string;
  startedBy: string;
}

export interface ApprovalApplyResult {
  appliedAt?: string;
  appliedBy?: string;
  result?: 'success' | 'failed' | 'rolled_back';
  auditRef?: string;
}

/**
 * SO-04 Task 3: the governed effect an approved decision triggers. Carried on
 * the request record so the single decision-resolution choke point
 * (`decideApprovalRequest` below) can execute it without any caller
 * (bridges, native-action handlers, text-decision resolvers) needing to know
 * steering exists — see `scheduleSteeringApprovalExecution` below and
 * `libs/core/surface/surface-mission-steering.ts`.
 */
export type ApprovalSteeringAction =
  | {
      kind: 'mission_lifecycle_verb';
      verb: 'verify' | 'finish';
      missionId: string;
      note?: string;
      surface: SurfaceAsyncChannel;
      channel: string;
      threadTs: string;
      correlationId: string;
    }
  | HeldEffectSteeringAction;

export interface ApprovalRequestRecord extends ApprovalRequestDraft {
  id: string;
  /** MO-11 S-1: `mission_gate` = a mission phase gate awaiting Sovereign approval. */
  kind: 'channel-approval' | 'secret_mutation' | 'mission_gate';
  storageChannel: string;
  channel: string;
  threadTs: string;
  correlationId: string;
  requestedBy: string;
  /** Human-readable name of the requester (display only, never compared). */
  requestedByDisplayName?: string;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Human-readable name of the decider (display only, never compared). */
  decidedByDisplayName?: string;
  /** Durable copy of the decision identity used by fail-closed consumers. */
  decidedByType?: ApprovalRecord['decidedByType'];
  /** How the surface obtained `decidedBy` (see ApprovalDeciderIdentitySource). */
  decidedByIdentitySource?: ApprovalDeciderIdentitySource;
  authenticated?: boolean;
  /**
   * MO-11 S-3: how the decider was authenticated. Previously this survived only
   * inside `workflow.approvals[]` and the event log, so a record without a
   * workflow lost it entirely — and every surface queue renders records, not
   * event logs. Carried here so a weakly-authenticated decision (e.g. the
   * `brief` surface's `local_token`) stays visible wherever it is reviewed.
   */
  decidedAuthMethod?: ApprovalRecord['authMethod'];
  /** HA-03: the decision was let through below `min_assurance` (warn rollout mode). */
  assuranceShortfall?: assurance.ApprovalAssuranceShortfall;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'applied' | 'failed';
  sourceText?: string;
  /** KC-03: origin of the request, for source-scoped cancellation. */
  source?: ApprovalRequestSource;
  expiresAt?: string;
  requestedByContext?: ApprovalRequesterContext;
  target?: ApprovalTargetDescriptor;
  justification?: ApprovalJustification;
  risk?: ApprovalRiskProfile;
  workflow?: ApprovalWorkflowState;
  applyResult?: ApprovalApplyResult;
  applyClaim?: ApprovalApplyClaim;
  /** SO-04 Task 3: present only for approval requests created by mission steering. */
  steering?: ApprovalSteeringAction;
  track_id?: string;
  track_name?: string;
  work_loop?: OrganizationWorkLoopSummary;
  accountability?: ApprovalAccountability;
  /** Optional server attestation, accepted only by the bounded diagnostic consumers. */
  diagnosticDecision?: FirstJobDecisionProof;
  /** Canonical authority scope of the effect being approved. */
  scope?: EventScope;
  /**
   * Autonomous-operation P1-6: what the operator sees on a phone — display
   * only, never the decision. See `decision-card.ts` / `approval-decision-card.ts`.
   */
  decisionCard?: DecisionCard;
  /** Set when a rejection asks the requester to revise and re-submit. */
  changeRequest?: ApprovalChangeRequest;
  /** Autonomous-operation P1-7: present when silence after delivery lets the request proceed. */
  veto?: ApprovalVetoWindow;
  /**
   * Set by `revokeApprovalRequest`: the approval was revoked and further uses
   * are refused. The status stays `approved` (the decision happened), but
   * `evaluateApprovalUsability` refuses it for every consumer.
   */
  revocation?: ApprovalRevocation;
  /** A one-shot effect used this approval (`markApprovalConsumed`); it cannot be revoked. */
  consumption?: ApprovalConsumption;
  /** Agent session the terminal decision was typed in (decider recorded as caller_supplied). */
  decidedInAgentSession?: string;
  /** `cli_tty_challenge`: a terminal approval confirmed by a typed challenge (best effort). */
  decidedVia?: 'cli_tty_challenge';
}

export interface ApprovalChangeRequest {
  instruction: string;
  requestedBy: string;
  requestedAt: string;
}

/** Longest change instruction kept on a record. */
export const APPROVAL_CHANGE_INSTRUCTION_MAX = 2000;

export interface ApprovalDecisionPayload {
  requestId: string;
  decision: 'approved' | 'rejected';
}

/**
 * KC-03: action descriptor for the session approval cache. Keys the cache by
 * what the agent is doing (op + target class), never by the concrete payload —
 * payload-hash binding stays the job of ApprovalAccountability.
 */
export interface ApprovalActionDescriptor {
  /** Operation/action identifier, e.g. 'secret:set'. */
  action: string;
  /** Class of the target, e.g. 'service:github' — never a concrete payload. */
  targetClass: string;
}

/** KC-03: originating mission/task/agent of an approval request. */
export interface ApprovalRequestSource {
  missionId?: string;
  taskId?: string;
  agentId?: string;
}

export interface SessionApprovalCacheEntry {
  key: string;
  action: string;
  targetClass: string;
  grantedByRequestId: string;
  grantedBy: string;
  /** The agent that requested the human-approved effect. */
  grantedForAgent: string;
  grantedAt: string;
  channel: string;
  storageChannel: string;
  /** Mirrors the originating request's expiry: the cache never outlives the grant. */
  expiresAt?: string;
  /** Exact-effect binding carried forward from the seed approval. */
  payloadHash: string;
  effectBinding: string;
  /** Optional mission/task scope; when present it must match on lookup. */
  source?: ApprovalRequestSource;
}

export interface SessionApprovalCacheLookupContext {
  agentId: string;
  payloadHash: string;
  effectBinding: string;
  source?: ApprovalRequestSource;
}

export function approvalActionCacheKey(descriptor: ApprovalActionDescriptor): string {
  const action = String(descriptor?.action || '')
    .trim()
    .toLowerCase();
  const targetClass = String(descriptor?.targetClass || '')
    .trim()
    .toLowerCase();
  if (!action || !targetClass) {
    throw new Error(
      '[POLICY_VIOLATION] Session approval cache requires both action and targetClass'
    );
  }
  return `${action}::${targetClass}`;
}

// Process-lifetime = session scope. Entries are only written by
// decideApprovalRequest after validating a real, authenticated human approval.
const sessionApprovalCache = new Map<string, SessionApprovalCacheEntry>();

export function lookupSessionApprovalCache(
  descriptor: ApprovalActionDescriptor,
  now = Date.now(),
  context: SessionApprovalCacheLookupContext
): SessionApprovalCacheEntry | null {
  const key = approvalActionCacheKey(descriptor);
  const entry = sessionApprovalCache.get(key);
  if (!entry) return null;
  if (isApprovalRequestExpired(entry, now)) {
    sessionApprovalCache.delete(key);
    return null;
  }
  if (
    entry.grantedForAgent !== context.agentId ||
    entry.payloadHash !== context.payloadHash ||
    entry.effectBinding !== context.effectBinding
  ) {
    return null;
  }
  // A scoped request must never consume an unscoped cache entry, and a
  // scoped seed must only be reused by the same source scope.
  if (Boolean(entry.source) !== Boolean(context.source)) return null;
  if (
    entry.source &&
    !(['missionId', 'taskId', 'agentId'] as const).every(
      (field) => entry.source?.[field] === context.source?.[field]
    )
  ) {
    return null;
  }
  return entry;
}

export function clearSessionApprovalCache(): void {
  sessionApprovalCache.clear();
}

/** Drop the session-cache grants a request seeded (its approval was revoked). */
export function forgetSessionApprovalCacheFor(requestId: string): void {
  for (const [key, entry] of sessionApprovalCache) {
    if (entry.grantedByRequestId === requestId) sessionApprovalCache.delete(key);
  }
}

/** KC-03: make cache-based auto-approvals durable in the decision event stream. */
export function recordSessionCacheAutoApproval(
  role: GovernedArtifactRole,
  params: {
    entry: SessionApprovalCacheEntry;
    operationId: string;
    agentId: string;
    correlationId: string;
  }
): void {
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(params.entry.storageChannel), {
    ts: nowIso(),
    event: 'auto_approved_via_session_cache',
    request_id: params.entry.grantedByRequestId,
    correlation_id: params.correlationId,
    operation_id: params.operationId,
    agent_id: params.agentId,
    action: params.entry.action,
    target_class: params.entry.targetClass,
    granted_by: params.entry.grantedBy,
    granted_at: params.entry.grantedAt,
    channel: params.entry.channel,
  });
}

/**
 * MO-11 S-4: statuses that represent a settled decision. `applied` / `failed`
 * are post-decision effect outcomes, so they are settled too.
 */
const TERMINAL_DECIDED_STATUSES: ReadonlySet<ApprovalRequestRecord['status']> = new Set([
  'approved',
  'rejected',
  'applied',
  'failed',
]);

export {
  APPROVAL_PLACEHOLDER_DECIDERS,
  approvalRequesterIdentities,
  approvalRevokeCommand,
  approvalUsabilityRefusal,
  assertApprovalUsable,
  evaluateApprovalUsability,
  evaluateSeparationOfDuties,
  isSeparationOfDutiesEnabled,
  normalizeApprovalPrincipalId,
  type ApprovalDeciderIdentitySource,
  type ApprovalUnusableReason,
  type SeparationOfDutiesViolation,
} from './approval-separation-of-duties.js';

/**
 * Enforce `approval-policy.json` `separation_of_duties` (default off) for an
 * approving decision. Rejections are never subject to it: a requester
 * declining their own request only withdraws it. A refusal is written to the
 * audit chain and the channel's approval event log before it throws.
 */
function enforceSeparationOfDutiesOnDecision(
  role: GovernedArtifactRole,
  params: {
    record: ApprovalRequestRecord;
    storageChannel: string;
    decidedBy: unknown;
    identitySource?: ApprovalDeciderIdentitySource;
  }
): void {
  if (!resolveSeparationOfDutiesPolicy().enabled) return;
  const violation = evaluateSeparationOfDuties(
    params.record,
    params.decidedBy,
    params.identitySource
  );
  if (!violation) return;
  const { record } = params;
  const decidedBy = typeof params.decidedBy === 'string' ? params.decidedBy : '';
  const reason = `Separation of duties: approval refused because ${SEPARATION_OF_DUTIES_MESSAGES[violation]}`;
  auditSeparationOfDutiesRefusal({ record, violation, decidedBy, stage: 'decide', reason });
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(params.storageChannel), {
    ts: nowIso(),
    event: 'separation_of_duties_refused',
    request_id: record.id,
    correlation_id: record.correlationId,
    stage: 'decide',
    violation,
    decided_by: decidedBy,
    requested_by: record.requestedBy,
    channel: record.channel,
    thread_ts: record.threadTs,
  });
  throw new Error(
    `[POLICY_VIOLATION] ${reason} (request ${record.id}). The request stays pending: a different, server-identified principal must decide it.`
  );
}

export { approvalStoreRoots, VITEST_APPROVAL_STORE_ROOT } from './approval-store-paths.js';

function approvalRequestsLogicalDir(storageChannel: string): string {
  return `${approvalStoreRoots().coordination}/${normalizeApprovalChannel(storageChannel)}/approvals/requests`;
}

export function approvalRequestLogicalPath(storageChannel: string, id: string): string {
  return `${approvalRequestsLogicalDir(storageChannel)}/${normalizeApprovalRequestId(id)}.json`;
}

export function approvalEventLogicalPath(storageChannel: string): string {
  return `${approvalStoreRoots().observability}/${normalizeApprovalChannel(storageChannel)}/approvals.jsonl`;
}

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
  }
): ApprovalRequestRecord {
  if (params.decisionCard) validateDecisionCard(params.decisionCard);
  if (params.veto && params.accountability?.finalDecision === 'human_only') {
    throw new Error(
      '[POLICY_VIOLATION] A veto-window request cannot also require a human-only final decision'
    );
  }
  const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
  ensureGovernedArtifactDir(role, approvalRequestsLogicalDir(storageChannel));

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
    ...(params.scope ? { scope: normalizeEventScope(params.scope) } : {}),
    ...(params.decisionCard ? { decisionCard: params.decisionCard } : {}),
    ...(params.veto ? { veto: params.veto } : {}),
  };

  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, record.id), record);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
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

/** Treat a malformed expiry as expired so approval cannot fail open. */
export function isApprovalRequestExpired(
  record: Pick<ApprovalRequestRecord, 'expiresAt'>,
  now = Date.now()
): boolean {
  if (typeof record.expiresAt !== 'string' || record.expiresAt.trim() === '') return false;
  const expiresAt = Date.parse(record.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

/** Serialize competing decision/cancellation/expiry/revocation transitions for one canonical record. */
export function withApprovalRecordLock<T>(
  role: GovernedArtifactRole,
  params: { channel: string; storageChannel?: string; requestId: string },
  fn: () => T
): T {
  const channel = normalizeApprovalChannel(params.storageChannel || params.channel);
  const id = normalizeApprovalRequestId(params.requestId);
  return withExecutionContext(role, () =>
    withLockSync('approval-record-' + channel + '-' + id, fn)
  );
}
/** Persist the terminal expiry transition exactly once. */
export function expireApprovalRequest(
  role: GovernedArtifactRole,
  params: Parameters<typeof expireApprovalRequestUnlocked>[1]
): ApprovalRequestRecord {
  return withApprovalRecordLock(role, params, () => expireApprovalRequestUnlocked(role, params));
}
function expireApprovalRequestUnlocked(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    /** Why the request expired; recorded on the event (e.g. `stale_pending`). */
    reason?: string;
  }
): ApprovalRequestRecord {
  const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
  const record = loadApprovalRequest(storageChannel, params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);
  if (record.status !== 'pending') return record;

  const updated: ApprovalRequestRecord = { ...record, status: 'expired' };
  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, updated.id), updated);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: nowIso(),
    event: 'expired',
    request_id: updated.id,
    correlation_id: updated.correlationId,
    channel: updated.channel,
    thread_ts: updated.threadTs,
    ...(params.reason ? { reason: params.reason } : {}),
  });
  projectApprovalWorkerEvent(
    'approval_response',
    {
      request_id: updated.id,
      correlation_id: updated.correlationId,
      status: 'expired',
      channel: updated.channel,
    },
    approvalWorkerEventSource(updated)
  );
  return updated;
}

/** KC-03: persist the terminal cancellation transition exactly once (mirrors expiry). */
export function cancelApprovalRequest(
  role: GovernedArtifactRole,
  params: Parameters<typeof cancelApprovalRequestUnlocked>[1]
): ApprovalRequestRecord {
  return withApprovalRecordLock(role, params, () => cancelApprovalRequestUnlocked(role, params));
}
function cancelApprovalRequestUnlocked(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    cancelledBy?: string;
    reason?: string;
  }
): ApprovalRequestRecord {
  const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
  const record = loadApprovalRequest(storageChannel, params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);
  if (record.status !== 'pending') return record;

  const updated: ApprovalRequestRecord = { ...record, status: 'cancelled' };
  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, updated.id), updated);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: nowIso(),
    event: 'cancelled',
    request_id: updated.id,
    correlation_id: updated.correlationId,
    cancelled_by: params.cancelledBy,
    reason: params.reason,
    source: updated.source,
    channel: updated.channel,
    thread_ts: updated.threadTs,
  });
  projectApprovalWorkerEvent(
    'approval_response',
    {
      request_id: updated.id,
      correlation_id: updated.correlationId,
      status: 'cancelled',
      ...(params.cancelledBy ? { decided_by: params.cancelledBy } : {}),
      channel: updated.channel,
    },
    approvalWorkerEventSource(updated)
  );
  return updated;
}

const APPROVAL_SOURCE_FIELDS = ['missionId', 'taskId', 'agentId'] as const;

/**
 * KC-03: cancel every pending approval request originating from the given
 * mission/task/agent so an aborted turn leaves no orphan pending approvals.
 * Filter fields are subset-matched: `{ missionId }` cancels across all of that
 * mission's tasks; `{ taskId }` only that task's requests.
 */
export function cancelApprovalRequestsBySource(
  role: GovernedArtifactRole,
  params: {
    source: ApprovalRequestSource;
    storageChannels?: string[];
    cancelledBy?: string;
    reason?: string;
  }
): ApprovalRequestRecord[] {
  const specified = APPROVAL_SOURCE_FIELDS.filter((field) => {
    const value = params.source?.[field];
    return typeof value === 'string' && value.trim() !== '';
  });
  if (specified.length === 0) {
    throw new Error(
      '[POLICY_VIOLATION] cancelApprovalRequestsBySource requires at least one source field'
    );
  }

  const pending = listApprovalRequests({
    storageChannels: params.storageChannels,
    status: 'pending',
  });
  const cancelled: ApprovalRequestRecord[] = [];
  for (const record of pending) {
    if (!record.source) continue;
    if (!specified.every((field) => record.source?.[field] === params.source[field])) continue;
    cancelled.push(
      cancelApprovalRequest(role, {
        channel: record.channel,
        storageChannel: record.storageChannel,
        requestId: record.id,
        cancelledBy: params.cancelledBy,
        reason: params.reason,
      })
    );
  }
  return cancelled;
}

/**
 * LC-10 (bridge ask-why): attach a rejection reason AFTER the decision was
 * recorded — bridges decide via a button first and ask "why" as a follow-up.
 * Updates the rejected workflow entry and appends a dedicated event so the
 * learning/re-execution loops see the reason in the event stream.
 */
export function annotateApprovalRejectionReason(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    reasonCategory: RejectionReasonCategory;
    note?: string;
    annotatedBy: string;
  }
): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.channel;
  const record = loadApprovalRequest(normalizeApprovalChannel(storageChannel), params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);
  const workflow = record.workflow
    ? {
        ...record.workflow,
        approvals: record.workflow.approvals.map((approval) =>
          approval.status === 'rejected'
            ? {
                ...approval,
                reasonCategory: params.reasonCategory,
                note: params.note ?? approval.note,
              }
            : approval
        ),
      }
    : undefined;
  const updated: ApprovalRequestRecord = { ...record, workflow };
  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, updated.id), updated);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: nowIso(),
    event: 'rejection_reason_captured',
    request_id: updated.id,
    correlation_id: updated.correlationId,
    annotated_by: params.annotatedBy,
    reason_category: params.reasonCategory,
    note: params.note,
    channel: updated.channel,
    thread_ts: updated.threadTs,
  });
  return updated;
}

export function loadApprovalRequest(
  storageChannel: string,
  id: string
): ApprovalRequestRecord | null {
  return readGovernedArtifactJson<ApprovalRequestRecord>(
    approvalRequestLogicalPath(storageChannel, id)
  );
}

export function listApprovalRequests(params?: {
  storageChannels?: string[];
  status?: ApprovalRequestRecord['status'] | ApprovalRequestRecord['status'][];
  kind?: ApprovalRequestRecord['kind'] | ApprovalRequestRecord['kind'][];
  scope?: EventScopeInput;
}): ApprovalRequestRecord[] {
  const channelsRoot = pathResolver.resolve(approvalStoreRoots().coordination);
  if (!safeExistsSync(channelsRoot)) return [];

  const statuses = params?.status
    ? new Set(Array.isArray(params.status) ? params.status : [params.status])
    : null;
  const kinds = params?.kind
    ? new Set(Array.isArray(params.kind) ? params.kind : [params.kind])
    : null;
  const requestedScopeKind = params?.scope?.scope_kind;
  const scopeFilter = params?.scope ? normalizeEventScope(params.scope) : undefined;
  const storageChannels = params?.storageChannels?.length
    ? params.storageChannels.map((channel) => normalizeApprovalChannel(channel, 'storage channel'))
    : safeReaddir(channelsRoot).filter((entry) =>
        safeExistsSync(
          pathResolver.resolve(
            approvalRequestsLogicalDir(normalizeApprovalChannel(entry, 'storage channel'))
          )
        )
      );

  const records: ApprovalRequestRecord[] = [];
  for (const storageChannel of storageChannels) {
    const requestsDir = pathResolver.resolve(approvalRequestsLogicalDir(storageChannel));
    if (!safeExistsSync(requestsDir)) continue;
    for (const entry of safeReaddir(requestsDir).filter((item) => item.endsWith('.json'))) {
      const record = loadApprovalRequest(storageChannel, entry.replace(/\.json$/, ''));
      if (!record) continue;
      if (statuses && !statuses.has(record.status)) continue;
      if (kinds && !kinds.has(record.kind)) continue;
      if (scopeFilter) {
        if (record.scope?.tier !== scopeFilter.tier) continue;
        if (
          !eventScopeMatches(record.scope, {
            ...(requestedScopeKind ? { scope_kind: requestedScopeKind } : {}),
            tenant_slug: scopeFilter.tenant_slug,
            organization_id: scopeFilter.organization_id,
            project_id: scopeFilter.project_id,
            mission_id: scopeFilter.mission_id,
            task_id: scopeFilter.task_id,
          })
        )
          continue;
      }
      records.push(record);
    }
  }

  return records.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

export function decideApprovalRequest(
  role: GovernedArtifactRole,
  params: Parameters<typeof decideApprovalRequestUnlocked>[1]
): ApprovalRequestRecord {
  return withApprovalRecordLock(role, params, () => decideApprovalRequestUnlocked(role, params));
}
function decideApprovalRequestUnlocked(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    /** Display name of the decider (see `cli-operator-principal.ts`). */
    decidedByDisplayName?: string;
    decidedInAgentSession?: string;
    decidedVia?: 'cli_tty_challenge';
    decidedByRole?: string;
    authMethod?: ApprovalRecord['authMethod'];
    decidedByType?: 'human' | 'ai_agent' | 'service';
    /**
     * `caller_supplied` when the surface took `decidedBy` as free text from
     * its caller rather than resolving it (see ApprovalDeciderIdentitySource).
     */
    deciderIdentitySource?: ApprovalDeciderIdentitySource;
    authenticated?: boolean;
    payloadHash?: string;
    effectBinding?: string;
    /** HA-06: digest of what the surface showed the decider (approval-presentation.ts). */
    presentedDigest?: string;
    /** HA-07: the verified challenge a `passkey` decision consumes (approval-passkey-challenge.ts). */
    passkeyChallengeId?: string;
    /** The principal an HTTP route resolved for the decider; an agent principal is refused for human-only. */
    deciderPrincipal?: ApprovalDeciderPrincipal | null;
    note?: string;
    /** LC-10: closed-vocabulary rejection reason (see rejection-reason.ts). */
    reasonCategory?: RejectionReasonCategory;
    /**
     * KC-03: opt in to auto-approving the same action class for the rest of
     * this process session. Only honored for `approved` decisions made by a
     * real, authenticated human — never for rejections.
     */
    sessionCache?: ApprovalActionDescriptor;
    /** Only with `rejected` — the requester should revise and re-submit. */
    changeInstruction?: string;
    diagnosticDecision?: FirstJobDecisionProof;
    /** Compare the exact reviewed snapshot under the canonical transition lock. */
    expectedRecordHash?: string;
  }
): ApprovalRequestRecord {
  const changeInstruction = params.changeInstruction?.trim();
  if (params.changeInstruction !== undefined) {
    if (params.decision !== 'rejected') {
      throw new Error('[POLICY_VIOLATION] A change instruction can only accompany a rejection');
    }
    if (!changeInstruction || changeInstruction.length > APPROVAL_CHANGE_INSTRUCTION_MAX) {
      throw new Error(
        `[POLICY_VIOLATION] A change instruction must be 1-${APPROVAL_CHANGE_INSTRUCTION_MAX} characters`
      );
    }
  }
  const storageChannel = params.storageChannel || params.channel;
  const record = loadApprovalRequest(normalizeApprovalChannel(storageChannel), params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);

  if (
    params.expectedRecordHash !== undefined &&
    params.expectedRecordHash !== computeApprovalPayloadHash({ record })
  ) {
    throw new Error('[POLICY_VIOLATION] Approval request changed since review');
  }

  if (record.status === 'cancelled') {
    throw new Error(
      `[POLICY_VIOLATION] Approval request was cancelled and cannot be decided: ${record.id}`
    );
  }
  if (record.status === 'expired') {
    throw new Error(`[POLICY_VIOLATION] Approval request has expired: ${record.id}`);
  }

  // MO-11 S-4: a settled decision is audit evidence and must not be silently
  // flipped. The same request is visible on every surface at once (Slack,
  // concierge, chronos, terminal, brief), so without this the last surface to
  // act would win — approve in Slack, reject in the brief, and the record
  // quietly changes underneath any gate that already read it. First decision
  // wins; a genuine reversal must cancel and re-request, which stays visible
  // in the event log.
  if (TERMINAL_DECIDED_STATUSES.has(record.status)) {
    // A staged/multi-role workflow may still owe decisions from other roles;
    // only a fully-settled record is closed.
    const awaitingOtherRoles = (record.workflow?.approvals ?? []).some(
      (approval) => approval.status === 'pending'
    );
    if (!awaitingOtherRoles) {
      throw new Error(
        `[POLICY_VIOLATION] Approval request ${record.id} is already ${record.status}` +
          `${record.decidedBy ? ` (decided by ${record.decidedBy}` : ''}` +
          `${record.decidedBy && record.decidedAt ? ` at ${record.decidedAt}` : ''}` +
          `${record.decidedBy ? ')' : ''} and cannot be decided again.`
      );
    }
  }

  if (record.status === 'pending' && isApprovalRequestExpired(record)) {
    expireApprovalRequestUnlocked(role, {
      channel: record.channel,
      storageChannel,
      requestId: record.id,
    });
    throw new Error(`[POLICY_VIOLATION] Approval request has expired: ${record.id}`);
  }

  refuseHumanOnlyDecisionByAgentProcess(record, { principal: params.deciderPrincipal });
  const bound = bindPresentedDecision(record, params);
  settlePasskeyDecisionProof(role, record, { ...params, storageChannel });
  const assuranceShortfall = validateHumanFinalDecision({
    channel: normalizeApprovalChannel(storageChannel),
    accountability: record.accountability,
    decidedByType: params.decidedByType,
    authenticated: params.authenticated,
    authMethod: params.authMethod,
    payloadHash: bound.payloadHash,
    effectBinding: bound.effectBinding,
  });
  settleUnpresentedHumanDecision(record, bound, params.decidedBy);

  if (params.decision === 'approved') {
    enforceSeparationOfDutiesOnDecision(role, {
      record,
      storageChannel,
      decidedBy: params.decidedBy,
      identitySource: params.deciderIdentitySource,
    });
  }

  let cacheDescriptor = params.decision === 'approved' ? params.sessionCache : undefined;
  if (cacheDescriptor) {
    // The session cache is a standing grant, so its seed is held to the
    // human-only contract even when the record itself carries no
    // accountability binding. Fail before persisting so callers notice.
    const cacheShortfall = validateHumanFinalDecision({
      accountability: { finalDecision: 'human_only' },
      decidedByType: params.decidedByType,
      authenticated: params.authenticated,
      authMethod: params.authMethod,
    });
    approvalActionCacheKey(cacheDescriptor);
    if (
      record.accountability?.finalDecision !== 'human_only' ||
      !record.accountability.payloadHash ||
      !record.accountability.effectBinding
    ) {
      throw new Error(
        '[POLICY_VIOLATION] Session approval cache requires an exact human effect binding'
      );
    }
    // A decision let through below its assurance level (warn) never seeds the cache.
    if (assuranceShortfall || cacheShortfall) cacheDescriptor = undefined;
  }

  const decidedAt = nowIso();
  const workflow = record.workflow
    ? {
        ...record.workflow,
        approvals: record.workflow.approvals.map((approval) => {
          if (params.decidedByRole && approval.role !== params.decidedByRole) {
            return approval;
          }
          if (!params.decidedByRole && approval.status !== 'pending') {
            return approval;
          }
          return {
            ...approval,
            status: params.decision,
            approvedBy: params.decidedBy,
            approvedAt: decidedAt,
            authMethod: params.authMethod,
            decidedByType: params.decidedByType,
            authenticated: params.authenticated,
            payloadHash: bound.payloadHash,
            effectBinding: bound.effectBinding,
            note: params.note,
            reasonCategory: params.reasonCategory,
            ...(params.deciderIdentitySource
              ? { deciderIdentitySource: params.deciderIdentitySource }
              : {}),
          };
        }),
      }
    : undefined;

  const {
    changeRequest: priorChangeRequest,
    decidedByIdentitySource: _priorIdentitySource,
    decidedByDisplayName: _priorDisplayName,
    decidedInAgentSession: _priorAgentSession,
    decidedVia: _priorDecidedVia,
    ...recordWithoutChangeRequest
  } = record;
  const updated: ApprovalRequestRecord = {
    ...recordWithoutChangeRequest,
    ...(priorChangeRequest && params.decision !== 'approved'
      ? { changeRequest: priorChangeRequest }
      : {}),
    status: params.decision,
    decidedAt,
    decidedBy: params.decidedBy,
    ...(params.decidedByDisplayName ? { decidedByDisplayName: params.decidedByDisplayName } : {}),
    ...(params.decidedInAgentSession
      ? { decidedInAgentSession: params.decidedInAgentSession }
      : {}),
    ...(params.decidedVia ? { decidedVia: params.decidedVia } : {}),
    ...(params.deciderIdentitySource
      ? { decidedByIdentitySource: params.deciderIdentitySource }
      : {}),
    ...(params.decidedByType ? { decidedByType: params.decidedByType } : {}),
    ...(params.authenticated !== undefined ? { authenticated: params.authenticated } : {}),
    ...(params.authMethod ? { decidedAuthMethod: params.authMethod } : {}),
    ...(assuranceShortfall ? { assuranceShortfall } : {}),
    ...(params.diagnosticDecision ? { diagnosticDecision: params.diagnosticDecision } : {}),
    ...(changeInstruction
      ? {
          changeRequest: {
            instruction: changeInstruction,
            requestedBy: params.decidedBy,
            requestedAt: decidedAt,
          },
        }
      : {}),
    workflow,
  };

  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, updated.id), updated);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: nowIso(),
    event: params.decision,
    request_id: updated.id,
    correlation_id: updated.correlationId,
    decided_by: params.decidedBy,
    decided_by_role: params.decidedByRole,
    decider_identity_source: params.deciderIdentitySource,
    decided_in_agent_session: params.decidedInAgentSession,
    decided_via: params.decidedVia,
    auth_method: params.authMethod,
    decided_by_type: params.decidedByType,
    authenticated: params.authenticated,
    payload_hash: bound.payloadHash,
    effect_binding: bound.effectBinding,
    ...(params.presentedDigest ? { presented_digest: params.presentedDigest } : {}),
    ...(params.passkeyChallengeId ? { passkey_challenge_id: params.passkeyChallengeId } : {}),
    channel: updated.channel,
    thread_ts: updated.threadTs,
    // LC-10: the rejection rationale must survive into the event stream —
    // downstream re-execution and learning loops read events, not the nested
    // per-request workflow record.
    note: params.note,
    reason_category: params.reasonCategory,
    ...(changeInstruction ? { change_instruction: changeInstruction } : {}),
    ...(assuranceShortfall ? { assurance_shortfall: assuranceShortfall } : {}),
  });
  if (assuranceShortfall) reportAssuranceShortfall(updated, assuranceShortfall, params.decidedBy);
  projectApprovalWorkerEvent(
    'approval_response',
    {
      request_id: updated.id,
      correlation_id: updated.correlationId,
      status: params.decision,
      decided_by: params.decidedBy,
      channel: updated.channel,
      ...(params.reasonCategory ? { reason_category: params.reasonCategory } : {}),
    },
    approvalWorkerEventSource(updated)
  );

  if (cacheDescriptor) {
    const key = approvalActionCacheKey(cacheDescriptor);
    const entry: SessionApprovalCacheEntry = {
      key,
      action: cacheDescriptor.action.trim().toLowerCase(),
      targetClass: cacheDescriptor.targetClass.trim().toLowerCase(),
      grantedByRequestId: updated.id,
      grantedBy: params.decidedBy,
      grantedForAgent: updated.requestedBy,
      grantedAt: decidedAt,
      channel: updated.channel,
      storageChannel: updated.storageChannel,
      expiresAt: updated.expiresAt,
      payloadHash: updated.accountability!.payloadHash!,
      effectBinding: updated.accountability!.effectBinding!,
      ...(updated.source ? { source: updated.source } : {}),
    };
    sessionApprovalCache.set(key, entry);
    appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
      ts: nowIso(),
      event: 'session_cache_written',
      request_id: updated.id,
      correlation_id: updated.correlationId,
      action: entry.action,
      target_class: entry.targetClass,
      granted_by: params.decidedBy,
      channel: updated.channel,
      thread_ts: updated.threadTs,
    });
  }

  // SO-04 Task 3: the single choke point every decision path (native
  // action, `appr:<id>:decision` text, numbered-choice text — see
  // surface-approval-ui.ts) already funnels through. An approved decision on
  // a steering-originated request triggers its governed mission-lifecycle
  // verb here, so no caller can approve a steering request without the verb
  // eventually executing, and no caller needs to know steering exists.
  if (updated.status === 'approved' && updated.steering) {
    scheduleSteeringApprovalExecution(role, storageChannel, updated);
  }
  // SC-04: a rejected held-effect request must settle the held action too —
  // rejections do not run the steering-apply pipeline, so they bridge here.
  if (updated.status === 'rejected' && updated.steering?.kind === 'held_effect') {
    scheduleHeldEffectRejection(updated);
  }
  if (
    updated.status === 'approved' &&
    updated.kind === 'mission_gate' &&
    updated.requestedByContext?.pipelineRunId
  ) {
    schedulePipelineApprovalResume(role, storageChannel, updated);
  }

  return updated;
}

/**
 * PI-08: approval decisions are the single resume trigger for a suspended
 * pipeline. The adapter is deliberately asynchronous so every existing
 * approval surface keeps its synchronous decision contract; the resume
 * module re-reads the journal and binds the launch to the exact approval,
 * step, and mission before spawning anything.
 */
const pendingPipelineApprovalResumes = new Set<Promise<void>>();

function schedulePipelineApprovalResume(
  role: GovernedArtifactRole,
  storageChannel: string,
  record: ApprovalRequestRecord
): void {
  const task = (async () => {
    let applyResult: ApprovalApplyResult;
    try {
      const { resumePipelineRunAfterApproval } =
        await import('../pipeline/pipeline-approval-resume.js');
      const outcome = await resumePipelineRunAfterApproval(record);
      applyResult = {
        appliedAt: nowIso(),
        appliedBy: 'pipeline_approval_resume',
        result:
          outcome.status === 'started' || outcome.status === 'already_running'
            ? 'success'
            : 'failed',
        auditRef: outcome.reason,
      };
    } catch (error) {
      applyResult = {
        appliedAt: nowIso(),
        appliedBy: 'pipeline_approval_resume',
        result: 'failed',
        auditRef: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      recordApprovalApplyResult(role, {
        channel: record.channel,
        storageChannel,
        requestId: record.id,
        applyResult,
      });
    } catch {
      // The resume outcome is already represented by the journal/process; a
      // best-effort apply receipt must not turn a successful decision into an
      // unhandled rejection.
    }
  })();
  pendingPipelineApprovalResumes.add(task);
  void task.finally(() => pendingPipelineApprovalResumes.delete(task));
}

/**
 * SO-04 Task 3: fire-and-forget execution of an approved steering action,
 * mirroring the HA-01 background-review-fork pattern in
 * surface-runtime-orchestrator.ts (`void fork.catch(handleForkFailure)`) —
 * `decideApprovalRequest` stays synchronous for every existing caller
 * (bridges, kill-switch, approval-gate, …), and the mission-lifecycle verb
 * runs to completion in the background. Every in-flight execution is
 * tracked so hermetic tests can await draining instead of polling/sleeping;
 * see {@link drainPendingSteeringApprovalExecutions}. Uses a dynamic import
 * of `surface-mission-steering.js` to avoid a static import cycle (that
 * module imports `createApprovalRequest` from here) — same technique as
 * `kill-switch.ts`'s dynamic import of `approval-gate.js`.
 */
const pendingSteeringApprovalExecutions = new Set<Promise<void>>();

function scheduleSteeringApprovalExecution(
  role: GovernedArtifactRole,
  storageChannel: string,
  record: ApprovalRequestRecord
): void {
  const task = (async () => {
    let applyResult: ApprovalApplyResult;
    try {
      // Existing approval/steering cycle is tracked by the module-boundary baseline.
      const { executeApprovedMissionSteeringApproval } =
        // eslint-disable-next-line import/no-cycle -- baseline until the governance seam is split
        await import('../surface/surface-mission-steering.js');
      const outcome = await executeApprovedMissionSteeringApproval(record);
      applyResult = {
        appliedAt: nowIso(),
        appliedBy: 'surface_mission_steering',
        result: 'success',
        auditRef: outcome,
      };
    } catch (error) {
      applyResult = {
        appliedAt: nowIso(),
        appliedBy: 'surface_mission_steering',
        result: 'failed',
        auditRef: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      recordApprovalApplyResult(role, {
        channel: record.channel,
        storageChannel,
        requestId: record.id,
        applyResult,
      });
    } catch {
      // Best-effort persistence of the outcome — the verb itself already
      // ran (or failed) above; a failure to record that outcome must not
      // surface as an unhandled rejection.
    }
  })();
  pendingSteeringApprovalExecutions.add(task);
  void task.finally(() => pendingSteeringApprovalExecutions.delete(task));
}

/**
 * SC-04: fire-and-forget rejection bridge for held-effect steering records.
 * The decision record already settled above; this propagates the rejection
 * to the control-plane journal so the owner process sees it on catch-up.
 */
function scheduleHeldEffectRejection(record: ApprovalRequestRecord): void {
  const task = (async () => {
    try {
      const { settleHeldEffectDecision } = await import('./held-effect-bridge.js');
      await settleHeldEffectDecision(record, 'rejected');
    } catch (error) {
      auditChain.record({
        agentId: 'approval-store',
        action: 'held_effect',
        operation: 'reject_bridge',
        result: 'failed',
        metadata: {
          requestId: record.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })();
  pendingSteeringApprovalExecutions.add(task);
  void task.finally(() => pendingSteeringApprovalExecutions.delete(task));
}

/**
 * Test-only: await every in-flight fire-and-forget steering execution
 * scheduled by {@link decideApprovalRequest} so far. Real callers never need
 * this — production surfaces observe the outcome via the follow-up surface
 * outbox message `executeApprovedMissionSteeringApproval` sends, not by
 * blocking on the decision call.
 */
export function drainPendingSteeringApprovalExecutions(): Promise<void> {
  return Promise.all(Array.from(pendingSteeringApprovalExecutions)).then(() => undefined);
}

/**
 * Claim an exact approved snapshot before any external side effect. The claim
 * survives process crashes and terminal receipts never erase it. This is an
 * at-most-once fence, not an automatic retry or rollback mechanism.
 */
export function claimApprovalApply(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    appliedBy: string;
    expectedRecordHash: string;
    /** Exact command that opens a fresh request, quoted in a refusal. */
    rerequestCommand?: string;
  }
): ApprovalRequestRecord & { applyClaim: ApprovalApplyClaim } {
  return withApprovalRecordLock(role, params, () => {
    const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
    const record = loadApprovalRequest(storageChannel, params.requestId);
    if (!record) throw new Error('[POLICY_VIOLATION] Approval request not found');
    if (params.expectedRecordHash !== computeApprovalPayloadHash({ record })) {
      throw new Error('[POLICY_VIOLATION] Approval request changed before apply');
    }
    if (record.status !== 'approved' || isApprovalRequestExpired(record)) {
      throw new Error('[POLICY_VIOLATION] A current approved request is required before apply');
    }
    if (record.applyClaim || record.applyResult) {
      throw new Error('[POLICY_VIOLATION] Approval apply already started; recovery required');
    }
    if (!params.appliedBy.trim()) {
      throw new Error('[POLICY_VIOLATION] Approval apply requires an actor');
    }
    // A decision recorded before separation of duties was switched on must
    // not slip through at apply time.
    assertApprovalUsable(record, {
      consumer: 'apply_claim',
      rerequestCommand: params.rerequestCommand,
    });
    const updated = {
      ...record,
      applyClaim: { claimId: randomUUID(), startedAt: nowIso(), startedBy: params.appliedBy },
    };
    const claimPath = writeGovernedArtifactJson(
      role,
      approvalRequestLogicalPath(storageChannel, record.id),
      updated
    );
    // The side effect must not start until the claim is flushed successfully.
    safeFsyncFile(claimPath);
    appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
      ts: nowIso(),
      event: 'apply_started',
      request_id: record.id,
      correlation_id: record.correlationId,
      channel: record.channel,
      thread_ts: record.threadTs,
      apply_claim: updated.applyClaim,
    });
    return updated;
  });
}

/** Persist an approval request's terminal apply outcome (SO-04 Task 3). */
export function recordApprovalApplyResult(
  role: GovernedArtifactRole,
  params: Parameters<typeof recordApprovalApplyResultUnlocked>[1]
): ApprovalRequestRecord {
  return withApprovalRecordLock(role, params, () =>
    recordApprovalApplyResultUnlocked(role, params)
  );
}

function recordApprovalApplyResultUnlocked(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    applyResult: ApprovalApplyResult;
    claimId?: string;
  }
): ApprovalRequestRecord {
  const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
  const record = loadApprovalRequest(storageChannel, params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);
  if (record.applyClaim && params.claimId !== record.applyClaim.claimId) {
    throw new Error('[POLICY_VIOLATION] Approval apply claim does not match');
  }
  if (params.claimId && !record.applyClaim) {
    throw new Error('[POLICY_VIOLATION] Approval apply claim is missing');
  }
  if (record.applyClaim && record.applyResult) {
    throw new Error('[POLICY_VIOLATION] Approval apply result is already recorded');
  }
  // Only secret_mutation advances status into applied/failed. Pipeline and
  // steering resumes keep status=approved so await_decision / hasBoundApproval
  // still recognize the grant after the async apply receipt lands.
  const nextStatus: ApprovalRequestRecord['status'] =
    record.kind === 'secret_mutation'
      ? params.applyResult.result === 'success'
        ? 'applied'
        : params.applyResult.result === 'failed'
          ? 'failed'
          : record.status
      : record.status;
  const updated: ApprovalRequestRecord = {
    ...record,
    status: nextStatus,
    applyResult: params.applyResult,
  };
  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, updated.id), updated);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: nowIso(),
    event: params.applyResult.result === 'success' ? 'applied' : 'apply_failed',
    request_id: updated.id,
    correlation_id: updated.correlationId,
    channel: updated.channel,
    thread_ts: updated.threadTs,
    apply_result: params.applyResult,
  });
  return updated;
}
