import { createHash, randomUUID } from 'node:crypto';
import {
  appendGovernedArtifactJsonl,
  ensureGovernedArtifactDir,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from './artifact-store.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir } from './secure-io.js';
import {
  buildOrganizationWorkLoopSummary,
  type OrganizationWorkLoopSummary,
} from './work-design.js';

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
  surface: 'slack' | 'chronos' | 'terminal' | 'presence' | 'api' | 'system';
  actorId: string;
  actorRole: string;
  missionId?: string;
  runtimeId?: string;
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
  authMethod?: 'surface_session' | 'totp' | 'passkey' | 'manual';
  note?: string;
  decidedByType?: 'human' | 'ai_agent' | 'service';
  authenticated?: boolean;
  payloadHash?: string;
  effectBinding?: string;
}

export interface ApprovalAccountability {
  /** Final accountability is held by a human principal, never an agent/service. */
  finalDecision: 'human_only';
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

export interface ApprovalApplyResult {
  appliedAt?: string;
  appliedBy?: string;
  result?: 'success' | 'failed' | 'rolled_back';
  auditRef?: string;
}

export interface ApprovalRequestRecord extends ApprovalRequestDraft {
  id: string;
  kind: 'channel-approval' | 'secret_mutation';
  storageChannel: string;
  channel: string;
  threadTs: string;
  correlationId: string;
  requestedBy: string;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'applied' | 'failed';
  sourceText?: string;
  expiresAt?: string;
  requestedByContext?: ApprovalRequesterContext;
  target?: ApprovalTargetDescriptor;
  justification?: ApprovalJustification;
  risk?: ApprovalRiskProfile;
  workflow?: ApprovalWorkflowState;
  applyResult?: ApprovalApplyResult;
  track_id?: string;
  track_name?: string;
  work_loop?: OrganizationWorkLoopSummary;
  accountability?: ApprovalAccountability;
}

export interface ApprovalDecisionPayload {
  requestId: string;
  decision: 'approved' | 'rejected';
}

/** Stable SHA-256 fingerprint for binding an approval to its exact effect payload. */
export function computeApprovalPayloadHash(payload: Record<string, unknown> | undefined): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)])
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload || {})))
    .digest('hex');
}

export function validateHumanFinalDecision(params: {
  accountability?: ApprovalAccountability;
  decidedByType?: ApprovalRecord['decidedByType'];
  authenticated?: boolean;
  payloadHash?: string;
  effectBinding?: string;
}): void {
  if (params.accountability?.finalDecision !== 'human_only') return;
  if (params.decidedByType !== 'human') {
    throw new Error('[POLICY_VIOLATION] Final approval requires a human decider');
  }
  if (params.authenticated !== true) {
    throw new Error('[POLICY_VIOLATION] Final approval requires an authenticated human decider');
  }
  if (
    params.accountability.payloadHash &&
    params.payloadHash !== params.accountability.payloadHash
  ) {
    throw new Error('[POLICY_VIOLATION] Approval payload hash does not match the requested effect');
  }
  if (
    params.accountability.effectBinding &&
    params.effectBinding !== params.accountability.effectBinding
  ) {
    throw new Error(
      '[POLICY_VIOLATION] Approval effect binding does not match the requested operation'
    );
  }
}

export function approvalRequestLogicalPath(storageChannel: string, id: string): string {
  return `active/shared/coordination/channels/${normalizeApprovalChannel(storageChannel)}/approvals/requests/${normalizeApprovalRequestId(id)}.json`;
}

export function approvalEventLogicalPath(storageChannel: string): string {
  return `active/shared/observability/channels/${normalizeApprovalChannel(storageChannel)}/approvals.jsonl`;
}

export function createApprovalRequest(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    threadTs: string;
    correlationId: string;
    requestedBy: string;
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
  }
): ApprovalRequestRecord {
  const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
  ensureGovernedArtifactDir(
    role,
    `active/shared/coordination/channels/${storageChannel}/approvals/requests`
  );

  const record: ApprovalRequestRecord = {
    id: randomUUID(),
    kind: params.kind || 'channel-approval',
    storageChannel,
    channel: params.channel,
    threadTs: params.threadTs,
    correlationId: params.correlationId,
    requestedBy: params.requestedBy,
    requestedAt: new Date().toISOString(),
    status: 'pending',
    title: params.draft.title,
    summary: params.draft.summary,
    details: params.draft.details,
    severity: params.draft.severity || 'medium',
    sourceText: params.sourceText,
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
    accountability: params.accountability,
  };

  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, record.id), record);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: new Date().toISOString(),
    event: 'approval_requested',
    request_id: record.id,
    correlation_id: record.correlationId,
    requested_by: record.requestedBy,
    channel: record.channel,
    thread_ts: record.threadTs,
  });
  return record;
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
}): ApprovalRequestRecord[] {
  const channelsRoot = pathResolver.shared('coordination/channels');
  if (!safeExistsSync(channelsRoot)) return [];

  const statuses = params?.status
    ? new Set(Array.isArray(params.status) ? params.status : [params.status])
    : null;
  const kinds = params?.kind
    ? new Set(Array.isArray(params.kind) ? params.kind : [params.kind])
    : null;
  const storageChannels = params?.storageChannels?.length
    ? params.storageChannels.map((channel) => normalizeApprovalChannel(channel, 'storage channel'))
    : safeReaddir(channelsRoot).filter((entry) =>
        safeExistsSync(
          pathResolver.shared(
            `coordination/channels/${normalizeApprovalChannel(entry, 'storage channel')}/approvals/requests`
          )
        )
      );

  const records: ApprovalRequestRecord[] = [];
  for (const storageChannel of storageChannels) {
    const requestsDir = pathResolver.shared(
      `coordination/channels/${storageChannel}/approvals/requests`
    );
    if (!safeExistsSync(requestsDir)) continue;
    for (const entry of safeReaddir(requestsDir).filter((item) => item.endsWith('.json'))) {
      const record = loadApprovalRequest(storageChannel, entry.replace(/\.json$/, ''));
      if (!record) continue;
      if (statuses && !statuses.has(record.status)) continue;
      if (kinds && !kinds.has(record.kind)) continue;
      records.push(record);
    }
  }

  return records.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

export function decideApprovalRequest(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedByRole?: string;
    authMethod?: ApprovalRecord['authMethod'];
    decidedByType?: 'human' | 'ai_agent' | 'service';
    authenticated?: boolean;
    payloadHash?: string;
    effectBinding?: string;
    note?: string;
  }
): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.channel;
  const record = loadApprovalRequest(normalizeApprovalChannel(storageChannel), params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);

  validateHumanFinalDecision({
    accountability: record.accountability,
    decidedByType: params.decidedByType,
    authenticated: params.authenticated,
    payloadHash: params.payloadHash,
    effectBinding: params.effectBinding,
  });

  const decidedAt = new Date().toISOString();
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
            payloadHash: params.payloadHash,
            effectBinding: params.effectBinding,
            note: params.note,
          };
        }),
      }
    : undefined;

  const updated: ApprovalRequestRecord = {
    ...record,
    status: params.decision,
    decidedAt,
    decidedBy: params.decidedBy,
    workflow,
  };

  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, updated.id), updated);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: new Date().toISOString(),
    event: params.decision,
    request_id: updated.id,
    correlation_id: updated.correlationId,
    decided_by: params.decidedBy,
    decided_by_role: params.decidedByRole,
    auth_method: params.authMethod,
    decided_by_type: params.decidedByType,
    authenticated: params.authenticated,
    payload_hash: params.payloadHash,
    effect_binding: params.effectBinding,
    channel: updated.channel,
    thread_ts: updated.threadTs,
  });

  return updated;
}
