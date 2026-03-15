import { randomUUID } from 'node:crypto';
import {
  appendGovernedArtifactJsonl,
  ensureGovernedArtifactDir,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from './artifact-store';

export interface ApprovalRequestDraft {
  title: string;
  summary: string;
  details?: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface ApprovalRequestRecord extends ApprovalRequestDraft {
  id: string;
  kind: 'channel-approval';
  storageChannel: string;
  channel: string;
  threadTs: string;
  correlationId: string;
  requestedBy: string;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  status: 'pending' | 'approved' | 'rejected';
  sourceText?: string;
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
  },
): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.channel;
  ensureGovernedArtifactDir(role, `active/shared/coordination/channels/${storageChannel}/approvals/requests`);

  const record: ApprovalRequestRecord = {
    id: randomUUID(),
    kind: 'channel-approval',
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

export function decideApprovalRequest(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
  },
): ApprovalRequestRecord {
  const storageChannel = params.storageChannel || params.channel;
  const record = loadApprovalRequest(storageChannel, params.requestId);
  if (!record) throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);

  const updated: ApprovalRequestRecord = {
    ...record,
    status: params.decision,
    decidedAt: new Date().toISOString(),
    decidedBy: params.decidedBy,
  };

  writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, updated.id), updated);
  appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
    ts: new Date().toISOString(),
    event: params.decision,
    request_id: updated.id,
    correlation_id: updated.correlationId,
    decided_by: params.decidedBy,
    channel: updated.channel,
    thread_ts: updated.threadTs,
  });

  return updated;
}
