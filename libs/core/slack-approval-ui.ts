import { randomUUID } from 'node:crypto';

import { createApprovalRequest, loadApprovalRequest } from './approval-store.js';
import { parseSafeJsonObjectInput } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import type { SupportedLocale } from './locale-normalize.js';
import { t } from './t.js';
import type { RejectionReasonCategory } from './rejection-reason.js';
import { appendGovernedArtifactJsonl } from './artifact-store.js';
import {
  applySurfaceApprovalDecision,
  applySurfaceApprovalRejectionReason,
  buildSurfaceApprovalAskWhyActions,
  normalizeSurfaceApprovalAskWhyCategory,
} from './surface-approval-ui.js';

import type {
  SlackApprovalActionPayload,
  SlackApprovalRequestDraft,
  SlackApprovalRequestRecord,
} from './channel-surface-types.js';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  type IntentResolutionContract,
} from './intent-resolution-contract.js';

function emitSlackApprovalEvent(event: Record<string, unknown>): string {
  return appendGovernedArtifactJsonl(
    'slack_bridge',
    'active/shared/observability/channels/slack/approvals.jsonl',
    {
      ts: nowIso(),
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

export function buildSlackApprovalBlocks(
  record: SlackApprovalRequestRecord,
  intentResolution?: IntentResolutionContract,
  locale: SupportedLocale = 'en'
): any[] {
  const severity = record.severity || 'medium';
  const labels = {
    understanding: t('bridge:contract_understanding', undefined, locale),
    missingInput: t('bridge:contract_missing_input', undefined, locale),
    authority: t('bridge:contract_authority', undefined, locale),
    nextAction: t('bridge:contract_next_action', undefined, locale),
    consequence: t('bridge:contract_consequence', undefined, locale),
    outcome: t('bridge:contract_outcome', undefined, locale),
    none: locale === 'en' ? 'None' : t('bridge:contract_none', undefined, locale),
  };
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${t('bridge:approval_heading', { surface: 'Slack' }, locale)}*\n*${record.title}*\n${record.summary}`,
      },
    },
    ...(record.details
      ? [
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${t('bridge:approval_details_label', undefined, locale)}: ${record.details}`,
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
          text: `${t('bridge:approval_severity_label', undefined, locale)}: ${severity} | Status: ${record.status}`,
        },
      ],
    },
    ...(intentResolution
      ? [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `*${labels.understanding}:* ${intentResolution.normalized_intent}`,
                `*${labels.missingInput}:* ${
                  intentResolution.missing_inputs.length > 0
                    ? intentResolution.missing_inputs.join(', ')
                    : labels.none
                }`,
                `*${labels.authority}:* ${renderIntentAuthorityLabel(intentResolution.authority_level, locale)}`,
                `*${labels.nextAction}:* ${intentResolution.next_action.label}`,
                `*${labels.consequence}:* ${intentResolution.next_action.consequence}`,
                `*${labels.outcome}:* ${renderIntentOutcomeLabel(intentResolution.outcome_kind, locale)}`,
              ].join('\n'),
            },
          },
        ]
      : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: {
            type: 'plain_text',
            text: t('bridge:approval_approve_button', undefined, locale),
          },
          action_id: 'slack_approval_decide',
          value: JSON.stringify({
            requestId: record.id,
            decision: 'approved' satisfies SlackApprovalActionPayload['decision'],
          }),
        },
        {
          type: 'button',
          style: 'danger',
          text: {
            type: 'plain_text',
            text: t('bridge:approval_reject_button', undefined, locale),
          },
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
  const parsed = parseSafeJsonObjectInput(value, 'Slack approval action');
  if (!parsed || typeof parsed.requestId !== 'string' || !parsed.requestId.trim()) {
    throw new Error('Slack approval action requires requestId');
  }
  if (parsed.decision !== 'approved' && parsed.decision !== 'rejected') {
    throw new Error('Slack approval action requires a valid decision');
  }
  return { requestId: parsed.requestId, decision: parsed.decision };
}

export function applySlackApprovalDecision(params: {
  requestId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
}): SlackApprovalRequestRecord {
  const record = loadApprovalRequest('slack', params.requestId);
  if (!record) throw new Error(`Approval request not found: slack/${params.requestId}`);
  const updated = applySurfaceApprovalDecision({
    surface: 'slack',
    requestId: params.requestId,
    decision: params.decision,
    channel: record.channel,
    threadTs: record.threadTs,
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

// ── LC-10 (bridge ask-why) ───────────────────────────────────────────────────
// A rejection decided by button gets ONE skippable follow-up question. Buttons
// (not free text) keep the reply deterministic — no conversation state needed.

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
      elements: buildSurfaceApprovalAskWhyActions(requestId).map((action) => ({
        type: 'button',
        text: { type: 'plain_text', text: action.label },
        action_id: 'slack_approval_askwhy',
        value: JSON.stringify({
          requestId: action.requestId,
          category: action.category,
        } satisfies SlackAskWhyActionPayload),
      })),
    },
  ];
}

export function parseSlackAskWhyAction(value: string): SlackAskWhyActionPayload {
  const parsed = parseSafeJsonObjectInput(value, 'Slack approval reason action');
  if (!parsed || typeof parsed.requestId !== 'string' || !parsed.requestId.trim()) {
    throw new Error('Slack approval reason action requires requestId');
  }
  const category = normalizeSurfaceApprovalAskWhyCategory(parsed.category);
  if (!category) throw new Error('Slack approval reason action requires a valid category');
  return { requestId: parsed.requestId, category };
}

/** @deprecated Use applySurfaceApprovalRejectionReason with explicit scope. */
export function applySlackApprovalRejectionReason(params: {
  requestId: string;
  category: RejectionReasonCategory;
  annotatedBy: string;
  channel: string;
  threadTs: string;
}): SlackApprovalRequestRecord {
  return applySurfaceApprovalRejectionReason({
    surface: 'slack',
    requestId: params.requestId,
    category: params.category,
    annotatedBy: params.annotatedBy,
    channel: params.channel,
    threadTs: params.threadTs,
  });
}
