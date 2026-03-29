import { randomUUID } from 'node:crypto';
import {
  appendGovernedArtifactJsonl,
  ensureGovernedArtifactDir,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from './artifact-store.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir } from './secure-io.js';
import { buildOrganizationWorkLoopSummary, type OrganizationWorkLoopSummary } from './work-design.js';

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
}

export interface ApprovalDecisionPayload {
  requestId: string;
  decision: 'approved' | 'rejected';
}

export function approvalRequestLogicalPath(storageChannel: string, id: string): string {
  return `active/shared/coordination/channels/${storageChannel}/approvals/requests/${id}.json`;
}

export function approvalEventLogicalPath(storageChannel: string): string {
  return `active/shared/observability/channels/${storageChannel}/approvals.jsonl`;
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
  },
): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.channel;
  ensureGovernedArtifactDir(role, `active/shared/coordination/channels/${storageChannel}/approvals/requests`);

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
    work_loop: params.workLoop || buildOrganizationWorkLoopSummary({
      intentId: 'approval-request',
      shape: 'task_session',
      outcomeIds: ['approval_request'],
      requiresApproval: true,
    }),
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

export function loadApprovalRequest(storageChannel: string, id: string): ApprovalRequestRecord | null {
  return readGovernedArtifactJson<ApprovalRequestRecord>(approvalRequestLogicalPath(storageChannel, id));
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
    ? params.storageChannels
    : safeReaddir(channelsRoot)
        .filter((entry) => safeExistsSync(pathResolver.shared(`coordination/channels/${entry}/approvals/requests`)));

  const records: ApprovalRequestRecord[] = [];
  for (const storageChannel of storageChannels) {
    const requestsDir = pathResolver.shared(`coordination/channels/${storageChannel}/approvals/requests`);
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
    note?: string;
  },
): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.channel;
  const record = loadApprovalRequest(storageChannel, params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);

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
    channel: updated.channel,
    thread_ts: updated.threadTs,
  });

  return updated;
}
