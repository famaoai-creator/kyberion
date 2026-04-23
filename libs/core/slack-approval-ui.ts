import { randomUUID } from 'node:crypto';

import { createApprovalRequest, decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import { appendGovernedArtifactJsonl } from './artifact-store.js';

import type {
  SlackApprovalActionPayload,
  SlackApprovalRequestDraft,
  SlackApprovalRequestRecord,
} from './channel-surface-types.js';

function emitSlackApprovalEvent(event: Record<string, unknown>): string {
  return appendGovernedArtifactJsonl('slack_bridge', 'active/shared/observability/channels/slack/approvals.jsonl', {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    channel: 'slack',
    ...event,
  });
}

export function createSlackApprovalRequest(params: {
  channel: string;
  threadTs: string;
  correlationId: string;
  requestedBy: string;
  draft: SlackApprovalRequestDraft;
  sourceText?: string;
}): SlackApprovalRequestRecord {
  const record = createApprovalRequest('slack_bridge', {
    channel: params.channel,
    storageChannel: 'slack',
    threadTs: params.threadTs,
    correlationId: params.correlationId,
    requestedBy: params.requestedBy,
    draft: params.draft,
    sourceText: params.sourceText,
  });
  emitSlackApprovalEvent({
    correlation_id: params.correlationId,
    decision: 'approval_requested',
    why: 'Surface flow requested explicit human approval before continuing execution.',
    policy_used: 'slack_approval_ui_v1',
    agent_id: params.requestedBy,
    resource_id: record.id,
    thread_ts: params.threadTs,
    slack_channel: params.channel,
  });
  return record;
}

export function loadSlackApprovalRequest(id: string): SlackApprovalRequestRecord | null {
  return loadApprovalRequest('slack', id);
}

export function buildSlackApprovalBlocks(record: SlackApprovalRequestRecord): any[] {
  const severity = record.severity || 'medium';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Approval Required*\n*${record.title}*\n${record.summary}`,
      },
    },
    ...(record.details
      ? [{
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Details: ${record.details}`,
            },
          ],
        }]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Severity: ${severity} | Status: ${record.status}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'slack_approval_decide',
          value: JSON.stringify({ requestId: record.id, decision: 'approved' satisfies SlackApprovalActionPayload['decision'] }),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Reject' },
          action_id: 'slack_approval_decide',
          value: JSON.stringify({ requestId: record.id, decision: 'rejected' satisfies SlackApprovalActionPayload['decision'] }),
        },
      ],
    },
  ];
}

export function parseSlackApprovalAction(value: string): SlackApprovalActionPayload {
  return JSON.parse(value) as SlackApprovalActionPayload;
}

export function applySlackApprovalDecision(params: {
  requestId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
}): SlackApprovalRequestRecord {
  const updated = decideApprovalRequest('slack_bridge', {
    channel: 'slack',
    storageChannel: 'slack',
    requestId: params.requestId,
    decision: params.decision,
    decidedBy: params.decidedBy,
  });
  emitSlackApprovalEvent({
    correlation_id: updated.correlationId,
    decision: params.decision,
    why: 'A human decision was captured from the Slack approval card.',
    policy_used: 'slack_approval_ui_v1',
    agent_id: updated.requestedBy,
    resource_id: updated.id,
    thread_ts: updated.threadTs,
    slack_channel: updated.channel,
    decided_by: params.decidedBy,
  });
  return updated;
}
