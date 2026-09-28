import type { GovernedArtifactRole } from './artifact-store.js';
import {
  AUTONOMY_APPROVAL_CHANNEL,
  neutralizeSurfaceMarkup,
  renderDecisionCardText,
  resolveInterventionLevel,
  resolveInterventionTiming,
  viewDecisionCard,
  type DecisionCardView,
  type InterventionLevel,
  type InterventionTiming,
} from './approval-decision-card.js';
import { recordAutonomousActionNotice } from './approval-digest.js';
import {
  createApprovalRequest,
  type ApprovalRequestRecord,
  type ApprovalRequestSource,
} from './approval-store.js';
import {
  approvalDeliveryCorrelationId,
  buildVetoWindow,
  markApprovalNotificationDelivered,
} from './approval-veto-window.js';
import { getAutonomousOpsPolicy, type AutonomousOpsGateResult } from './autonomous-ops-gate.js';
import { buildDecisionCard, type DecisionCardEvidence } from './decision-card.js';
import type { EventScopeInput } from './event-scope.js';
import type { SupportedLocale } from './locale-normalize.js';
import {
  loadNotificationPreferences,
  notifyOperatorSync,
  resolveOperatorNotificationRoute,
} from './operator-notifications.js';

/**
 * Autonomous-operation P1-6/P1-7: the one call an agent makes when the gate
 * has classified an action. It answers the agent's question — "may I act now,
 * or do I park this and move on?" — and does the operator-facing work (card,
 * veto window, notification, digest notice) so no caller hand-rolls HITL.
 *
 *   none / fyi → proceed now; a notice lands in the digest
 *   veto       → park; proceeds after the veto window unless the operator objects
 *   decide     → park; waits for the operator (the request expires, never hangs)
 *
 * A parked action is not a stopped agent: the caller should pick up other
 * work and resume when the request settles (approval-store events).
 */

export const DEFAULT_DECISION_EXPIRY_MINUTES = 72 * 60;

export interface RouteAutonomousDecisionInput {
  role: GovernedArtifactRole;
  gate: AutonomousOpsGateResult;
  title: string;
  /** One sentence: what the operator is asked to decide. */
  question: string;
  /** What the agent recommends, and why. */
  recommendation: string;
  evidence?: DecisionCardEvidence[];
  requestedBy: string;
  source?: ApprovalRequestSource;
  /** False when the agent has other work and the answer can wait for the digest. */
  blocking?: boolean;
  expiresInMinutes?: number;
  scope?: EventScopeInput;
  locale?: SupportedLocale;
  now?: number;
}

export interface RoutedDecision {
  level: InterventionLevel;
  timing: InterventionTiming;
  /** The agent may perform the action now. */
  proceed: boolean;
  /** The agent should park this action and continue with other work. */
  parked: boolean;
  shadow: boolean;
  requestId?: string;
  card?: DecisionCardView;
  /** The card was handed to a delivery path (not proof of delivery). */
  notified: boolean;
}

function activeHoursFromPolicy() {
  try {
    return getAutonomousOpsPolicy().active_hours;
  } catch {
    return undefined;
  }
}

export function routeAutonomousDecision(input: RouteAutonomousDecisionInput): RoutedDecision {
  const now = input.now ?? Date.now();
  const level = resolveInterventionLevel(input.gate);
  const timing = resolveInterventionTiming(level, { blocking: input.blocking });
  const shadow = input.gate.shadow;

  if (level === 'none' || level === 'fyi') {
    // Shadow actions never execute, so there is nothing to report as done.
    if (!shadow && input.gate.allowed) {
      recordAutonomousActionNotice(input.role, {
        actionId: input.gate.actionId,
        level,
        title: input.title,
        summary: input.question,
        ...(input.source?.missionId ? { missionId: input.source.missionId } : {}),
      });
    }
    return {
      level,
      timing,
      proceed: input.gate.allowed,
      parked: false,
      shadow,
      notified: false,
    };
  }

  const route = resolveOperatorNotificationRoute(
    'approval_required',
    loadNotificationPreferences()
  );
  const deliveredVia = route && route !== 'mute' ? route : undefined;
  const activeHours = activeHoursFromPolicy();
  const veto =
    level === 'veto'
      ? buildVetoWindow({
          windowMinutes: input.gate.vetoWindowMinutes ?? 0,
          activeHours,
          shadow,
          now,
        })
      : undefined;
  const expiresAt =
    level === 'decide'
      ? new Date(
          now + (input.expiresInMinutes ?? DEFAULT_DECISION_EXPIRY_MINUTES) * 60_000
        ).toISOString()
      : undefined;

  let record: ApprovalRequestRecord = createApprovalRequest(input.role, {
    channel: deliveredVia?.target ?? 'operator',
    storageChannel: AUTONOMY_APPROVAL_CHANNEL,
    threadTs: '',
    correlationId: `autonomy:${input.gate.actionId}:${now.toString(36)}`,
    requestedBy: input.requestedBy,
    draft: {
      title: input.title,
      summary: input.question,
      severity: level === 'decide' ? 'high' : 'medium',
    },
    kind: 'channel-approval',
    ...(expiresAt ? { expiresAt } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    // Veto requests are settled by the policy when silence elapses; a decide
    // request is a human's call and must stay one.
    ...(level === 'decide' ? { accountability: { finalDecision: 'human_only' as const } } : {}),
    decisionCard: buildDecisionCard({
      question: input.question,
      recommendation: input.recommendation,
      gate: input.gate,
      level,
      evidence: input.evidence,
      shadow,
      actionId: input.gate.actionId,
      ...(input.locale ? { locale: input.locale } : {}),
      ...(expiresAt ? { deadline: expiresAt } : {}),
      ...(activeHours ? { timezone: activeHours.timezone } : {}),
      ...(deliveredVia ? { deliveredVia } : {}),
    }),
    ...(veto ? { veto } : {}),
  });

  let card = viewDecisionCard(record, { now, locale: input.locale });
  let notified = false;
  if (timing === 'immediate') {
    const surface = deliveredVia?.surface;
    const safe = (text: string) => (surface ? neutralizeSurfaceMarkup(text, surface) : text);
    notified = notifyOperatorSync('approval_required', {
      title: safe(input.title),
      body: safe(renderDecisionCardText(card, input.locale)),
      correlation_id: approvalDeliveryCorrelationId(record),
    });
    // iMessage is sent synchronously, so a handed-off card is a delivered one;
    // outbox surfaces confirm delivery from the bridge (recordApprovalDeliveryReceipt).
    if (notified && veto && deliveredVia?.surface === 'imessage') {
      record =
        markApprovalNotificationDelivered(input.role, {
          storageChannel: record.storageChannel,
          requestId: record.id,
          deliveredAt: new Date(now).toISOString(),
        }) ?? record;
      card = viewDecisionCard(record, { now, locale: input.locale });
    }
  }

  return {
    level,
    timing,
    proceed: false,
    parked: true,
    shadow,
    requestId: record.id,
    card,
    notified,
  };
}
