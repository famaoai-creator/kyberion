import { randomUUID } from 'node:crypto';

import {
  annotateApprovalRejectionReason,
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
} from './approval-store.js';
import {
  REJECTION_REASON_CATEGORIES,
  normalizeRejectionReasonCategory,
  type RejectionReasonCategory,
} from './rejection-reason.js';
import { appendGovernedArtifactJsonl } from './artifact-store.js';

import type {
  SlackApprovalActionPayload,
  SlackApprovalRequestDraft,
  SlackApprovalRequestRecord,
} from './channel-surface-types.js';

function emitSlackApprovalEvent(event: Record<string, unknown>): string {
  return appendGovernedArtifactJsonl(
    'slack_bridge',
    'active/shared/observability/channels/slack/approvals.jsonl',
    {
      ts: new Date().toISOString(),
      event_id: randomUUID(),
      channel: 'slack',
      ...event,
    }
  );
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
      ? [
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Details: ${record.details}`,
              },
            ],
          },
        ]
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
          value: JSON.stringify({
            requestId: record.id,
            decision: 'approved' satisfies SlackApprovalActionPayload['decision'],
          }),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Reject' },
          action_id: 'slack_approval_decide',
          value: JSON.stringify({
            requestId: record.id,
            decision: 'rejected' satisfies SlackApprovalActionPayload['decision'],
          }),
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
  const record = loadApprovalRequest('slack', params.requestId);
  if (!record) throw new Error(`Approval request not found: slack/${params.requestId}`);
  const updated = decideApprovalRequest('slack_bridge', {
    channel: 'slack',
    storageChannel: 'slack',
    requestId: params.requestId,
    decision: params.decision,
    decidedBy: params.decidedBy,
    decidedByType: 'human',
    authenticated: true,
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
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

// ── LC-10 (bridge ask-why) ───────────────────────────────────────────────────
// A rejection decided by button gets ONE skippable follow-up question. Buttons
// (not free text) keep the reply deterministic — no conversation state needed.

const ASK_WHY_LABELS: Record<RejectionReasonCategory, string> = {
  incorrect_content: '内容が誤り',
  wrong_direction: '方向が違う',
  quality: '品質不足',
  scope: 'スコープ過不足',
  other: 'その他',
};

export interface SlackAskWhyActionPayload {
  requestId: string;
  category: RejectionReasonCategory | 'skip';
}

export function buildSlackApprovalAskWhyBlocks(requestId: string): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'どこが期待と違いましたか？(1問だけ・スキップ可 — 理由は次回の作業改善に使われます)',
      },
    },
    {
      type: 'actions',
      elements: [
        ...REJECTION_REASON_CATEGORIES.map((category) => ({
          type: 'button',
          text: { type: 'plain_text', text: ASK_WHY_LABELS[category] },
          action_id: 'slack_approval_askwhy',
          value: JSON.stringify({ requestId, category } satisfies SlackAskWhyActionPayload),
        })),
        {
          type: 'button',
          text: { type: 'plain_text', text: 'スキップ' },
          action_id: 'slack_approval_askwhy',
          value: JSON.stringify({ requestId, category: 'skip' } satisfies SlackAskWhyActionPayload),
        },
      ],
    },
  ];
}

export function parseSlackAskWhyAction(value: string): SlackAskWhyActionPayload {
  const parsed = JSON.parse(value) as SlackAskWhyActionPayload;
  if (parsed.category !== 'skip' && !normalizeRejectionReasonCategory(parsed.category)) {
    return { requestId: parsed.requestId, category: 'skip' };
  }
  return parsed;
}

export function applySlackApprovalRejectionReason(params: {
  requestId: string;
  category: RejectionReasonCategory;
  annotatedBy: string;
}): SlackApprovalRequestRecord {
  return annotateApprovalRejectionReason('slack_bridge', {
    channel: 'slack',
    storageChannel: 'slack',
    requestId: params.requestId,
    reasonCategory: params.category,
    annotatedBy: params.annotatedBy,
  });
}
