import type { ApprovalRequestRecord } from './approval-store.js';
import { evaluateVetoWindow, type VetoWindowState } from './approval-veto-window.js';
import type { AutonomousOpsGateResult } from './autonomous-ops-gate.js';
import { resolveLocale } from './locale.js';
import type { SupportedLocale } from './locale-normalize.js';
import type { NotificationChannelTarget } from './operator-notifications.js';
import { t, type VocabularyKey } from './t.js';

/**
 * Autonomous-operation P1-6: one answer to "do I need to do anything?".
 *
 * Every decision the agents raise is classified into four intervention levels,
 * derived from the autonomous-ops gate — never chosen by the acting agent:
 *
 * | level    | gate                         | the operator …                       | phone rings? |
 * | -------- | ---------------------------- | ------------------------------------ | ------------ |
 * | `none`   | auto                         | does nothing; it is in the digest    | no           |
 * | `fyi`    | notify                       | does nothing; reads it in the digest | no           |
 * | `veto`   | notify + `veto_window_minutes`| acts only to object before deadline  | yes, once    |
 * | `decide` | approve                      | must decide; the work waits          | yes, once    |
 *
 * The card always states what happens if the operator does nothing, so the
 * operator never has to infer whether silence blocks, delays or approves.
 */

export type InterventionLevel = 'none' | 'fyi' | 'veto' | 'decide';
export type InterventionTiming = 'immediate' | 'digest';
export type DecisionCardChoice = 'approve' | 'reject' | 'revise';
export type DecisionCardActionKind = 'approve' | 'revise' | 'reject' | 'explain';

/** Storage channel for decisions raised by autonomous operations. */
export const AUTONOMY_APPROVAL_CHANNEL = 'autonomy';

export const INTERVENTION_LEVELS: readonly InterventionLevel[] = ['decide', 'veto', 'fyi', 'none'];

/** Stored on the approval record so every surface renders the same card. */
export interface ApprovalDecisionCardContent {
  level: InterventionLevel;
  /** One sentence: what the operator is asked to decide. */
  ask: string;
  recommendation?: { choice: DecisionCardChoice; rationale: string };
  /** Plain-language reasons a human is involved (from the gate's escalations). */
  reasons: string[];
  reversible: boolean;
  evidence?: string[];
  actionId?: string;
  shadow?: boolean;
  /** IANA timezone deadlines are shown in (the policy's active-hours timezone). */
  timezone?: string;
  /** Where the card was sent; replies are accepted only from that surface and chat. */
  deliveredVia?: NotificationChannelTarget;
}

export interface DecisionCardAction {
  kind: DecisionCardActionKind;
  label: string;
  callbackData: string;
}

export interface DecisionCardView {
  requestId: string;
  title: string;
  level: InterventionLevel;
  ask: string;
  recommendation?: ApprovalDecisionCardContent['recommendation'];
  reasons: string[];
  reversible: boolean;
  evidence: string[];
  shadow: boolean;
  vetoState?: VetoWindowState;
  /** The instant that changes the outcome: when a veto proceeds or a decision expires. */
  deadlineAt?: string;
  ifNoResponse: string;
  actions: DecisionCardAction[];
}

const LEVEL_KEY: Record<InterventionLevel, VocabularyKey> = {
  decide: 'decision:level_decide',
  veto: 'decision:level_veto',
  fyi: 'decision:level_fyi',
  none: 'decision:level_none',
};

const CHOICE_KEY: Record<DecisionCardChoice, VocabularyKey> = {
  approve: 'decision:recommend_approve',
  reject: 'decision:recommend_reject',
  revise: 'decision:recommend_revise',
};

export function interventionLevelLabel(
  level: InterventionLevel,
  locale: SupportedLocale = resolveLocale()
): string {
  return t(LEVEL_KEY[level], undefined, locale);
}

type GateLike = Pick<
  AutonomousOpsGateResult,
  | 'decision'
  | 'vetoWindowMinutes'
  | 'escalations'
  | 'reason'
  | 'axes'
  | 'score'
  | 'maxScore'
  | 'highRiskPathMatches'
  | 'actionClass'
  | 'actionId'
  | 'shadow'
>;

export function resolveInterventionLevel(
  gate: Pick<AutonomousOpsGateResult, 'decision' | 'vetoWindowMinutes'>
): InterventionLevel {
  if (gate.decision === 'approve') return 'decide';
  if (gate.decision === 'notify') {
    return (gate.vetoWindowMinutes ?? 0) > 0 ? 'veto' : 'fyi';
  }
  return 'none';
}

/**
 * Interrupt only when the operator is the blocker (`decide`) or a veto clock is
 * about to start (`veto`, which cannot start until delivery). Everything else,
 * and decisions explicitly marked non-blocking, waits for the digest.
 */
export function resolveInterventionTiming(
  level: InterventionLevel,
  options: { blocking?: boolean } = {}
): InterventionTiming {
  if (level === 'veto') return 'immediate';
  if (level === 'decide') return options.blocking === false ? 'digest' : 'immediate';
  return 'digest';
}

function listText(values: readonly string[], max = 3): string {
  const shown = values.slice(0, max).join(', ');
  return values.length > max ? `${shown} +${values.length - max}` : shown;
}

/** Translate the gate's escalation codes into sentences an operator can act on. */
export function describeGateEscalations(
  gate: GateLike,
  locale: SupportedLocale = resolveLocale()
): string[] {
  const reasons: string[] = [];
  const axes = Object.entries(gate.axes)
    .filter(([, score]) => score >= 3)
    .map(([axis]) => axis);
  const neverAuto = /never-auto class: ([^;]+)/.exec(gate.reason)?.[1]?.trim();
  for (const escalation of gate.escalations) {
    switch (escalation) {
      case 'axis_max':
        reasons.push(t('decision:reason_axis_max', { axes: axes.join(', ') }, locale));
        break;
      case 'irreversible':
        reasons.push(t('decision:reason_irreversible', undefined, locale));
        break;
      case 'never_auto':
        reasons.push(
          t('decision:reason_never_auto', { classes: neverAuto || gate.actionClass || '' }, locale)
        );
        break;
      case 'high_risk_path':
        reasons.push(
          t('decision:reason_high_risk_path', { paths: listText(gate.highRiskPathMatches) }, locale)
        );
        break;
      case 'requested':
        reasons.push(t('decision:reason_requested', undefined, locale));
        break;
      case 'budget':
        reasons.push(t('decision:reason_budget', undefined, locale));
        break;
      default:
        reasons.push(escalation);
    }
  }
  if (reasons.length === 0 && gate.decision !== 'auto') {
    reasons.push(
      t('decision:reason_score', { score: String(gate.score), max: String(gate.maxScore) }, locale)
    );
  }
  return reasons;
}

export function buildDecisionCardContent(params: {
  gate: GateLike;
  ask: string;
  recommendation?: ApprovalDecisionCardContent['recommendation'];
  evidence?: string[];
  locale?: SupportedLocale;
}): ApprovalDecisionCardContent {
  return {
    level: resolveInterventionLevel(params.gate),
    ask: params.ask,
    ...(params.recommendation ? { recommendation: params.recommendation } : {}),
    reasons: describeGateEscalations(params.gate, params.locale),
    reversible: (params.gate.axes.reversibility ?? 3) <= 1,
    ...(params.evidence?.length ? { evidence: params.evidence } : {}),
    actionId: params.gate.actionId,
    ...(params.gate.shadow ? { shadow: true } : {}),
  };
}

export function formatDecisionInstant(
  iso: string,
  locale: SupportedLocale = resolveLocale(),
  timezone?: string
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(ms));
}

/**
 * The effective level of a stored request right now. Records created before
 * decision cards existed are human approvals, so they read as `decide`; a veto
 * whose notification never arrived also becomes `decide`.
 */
export function effectiveInterventionLevel(
  record: Pick<ApprovalRequestRecord, 'decisionCard' | 'veto'>,
  now = Date.now()
): InterventionLevel {
  if (record.veto) {
    return evaluateVetoWindow(record.veto, now) === 'undelivered' ? 'decide' : 'veto';
  }
  return record.decisionCard?.level ?? 'decide';
}

export function buildDecisionCardActions(
  record: Pick<ApprovalRequestRecord, 'id'>,
  level: InterventionLevel,
  locale: SupportedLocale = resolveLocale()
): DecisionCardAction[] {
  const veto = level === 'veto';
  return [
    {
      kind: 'approve',
      label: t(veto ? 'decision:action_proceed_now' : 'decision:action_approve', undefined, locale),
      callbackData: `appr:${record.id}:approve`,
    },
    {
      kind: 'revise',
      label: t('decision:action_revise', undefined, locale),
      callbackData: `appr:${record.id}:revise`,
    },
    {
      kind: 'reject',
      label: t(veto ? 'decision:action_object' : 'decision:action_reject', undefined, locale),
      callbackData: `appr:${record.id}:reject`,
    },
    {
      kind: 'explain',
      label: t('decision:action_explain', undefined, locale),
      callbackData: `appr:${record.id}:explain`,
    },
  ];
}

function describeIfNoResponse(
  record: ApprovalRequestRecord,
  level: InterventionLevel,
  vetoState: VetoWindowState | undefined,
  locale: SupportedLocale
): { text: string; deadlineAt?: string } {
  const timezone = record.veto?.activeHours?.timezone ?? record.decisionCard?.timezone;
  if (level === 'none' || level === 'fyi') {
    return { text: t('decision:if_no_response_done', undefined, locale) };
  }
  if (record.veto && vetoState !== 'undelivered') {
    if (record.veto.shadow) {
      return {
        text: t('decision:if_no_response_veto_shadow', undefined, locale),
        deadlineAt: record.veto.proceedsAt,
      };
    }
    if (record.veto.proceedsAt) {
      return {
        text: t(
          'decision:if_no_response_veto_counting',
          { deadline: formatDecisionInstant(record.veto.proceedsAt, locale, timezone) },
          locale
        ),
        deadlineAt: record.veto.proceedsAt,
      };
    }
    return {
      text: t(
        'decision:if_no_response_veto_waiting',
        { minutes: String(record.veto.windowMinutes) },
        locale
      ),
    };
  }
  const lines = [
    t(
      vetoState === 'undelivered'
        ? 'decision:if_no_response_undelivered'
        : 'decision:if_no_response_decide',
      undefined,
      locale
    ),
  ];
  if (record.expiresAt) {
    lines.push(
      t(
        'decision:if_no_response_decide_expires',
        { deadline: formatDecisionInstant(record.expiresAt, locale, timezone) },
        locale
      )
    );
  }
  return {
    text: lines.join(locale === 'ja' ? '' : ' '),
    ...(record.expiresAt ? { deadlineAt: record.expiresAt } : {}),
  };
}

export function viewDecisionCard(
  record: ApprovalRequestRecord,
  options: { now?: number; locale?: SupportedLocale } = {}
): DecisionCardView {
  const now = options.now ?? Date.now();
  const locale = options.locale ?? resolveLocale();
  const card = record.decisionCard;
  const level = effectiveInterventionLevel(record, now);
  const vetoState = record.veto ? evaluateVetoWindow(record.veto, now) : undefined;
  const noResponse = describeIfNoResponse(record, level, vetoState, locale);
  const evidence = [...(card?.evidence ?? []), ...(record.justification?.evidence ?? [])];
  return {
    requestId: record.id,
    title: record.title,
    level,
    ask: card?.ask ?? record.summary,
    ...(card?.recommendation ? { recommendation: card.recommendation } : {}),
    reasons: card?.reasons ?? (record.justification?.reason ? [record.justification.reason] : []),
    // Unknown reversibility is reported as irreversible: the safe reading.
    reversible: card?.reversible ?? false,
    evidence: [...new Set(evidence)],
    shadow: Boolean(card?.shadow || record.veto?.shadow),
    ...(vetoState ? { vetoState } : {}),
    ...(noResponse.deadlineAt ? { deadlineAt: noResponse.deadlineAt } : {}),
    ifNoResponse: noResponse.text,
    actions: buildDecisionCardActions(record, level, locale),
  };
}

/**
 * Plain-text card for chat surfaces. The order is fixed so the operator learns
 * where to look: level → ask → recommendation → why → undo → if-no-response.
 */
export function renderDecisionCardText(
  view: DecisionCardView,
  locale: SupportedLocale = resolveLocale()
): string {
  const lines = [
    `${interventionLevelLabel(view.level, locale)}${
      view.shadow ? ` ${t('decision:shadow_badge', undefined, locale)}` : ''
    }`,
    view.title,
    '',
    `${t('decision:ask_label', undefined, locale)}: ${view.ask}`,
  ];
  if (view.recommendation) {
    lines.push(
      `${t('decision:recommendation_label', undefined, locale)}: ${t(CHOICE_KEY[view.recommendation.choice], undefined, locale)} — ${view.recommendation.rationale}`
    );
  }
  if (view.reasons.length > 0) {
    lines.push(`${t('decision:why_human_label', undefined, locale)}:`);
    lines.push(...view.reasons.map((reason) => `  - ${reason}`));
  }
  lines.push(
    `${t('decision:reversible_label', undefined, locale)}: ${t(
      view.reversible ? 'decision:reversible_yes' : 'decision:reversible_no',
      undefined,
      locale
    )}`,
    `${t('decision:if_no_response_label', undefined, locale)}: ${view.ifNoResponse}`
  );
  if (view.evidence.length > 0) {
    lines.push(`${t('decision:evidence_label', undefined, locale)}: ${listText(view.evidence)}`);
  }
  if (view.level === 'decide' || view.level === 'veto') {
    lines.push('', t('decision:reply_hint', { requestId: view.requestId }, locale));
  }
  return lines.join('\n');
}

/** The "ask why" answer: the reasons, the recommendation and the evidence, without deciding. */
export function renderDecisionCardExplanation(
  view: DecisionCardView,
  locale: SupportedLocale = resolveLocale()
): string {
  const lines = [`${t('decision:explain_heading', undefined, locale)}: ${view.title}`];
  if (view.reasons.length > 0) {
    lines.push(...view.reasons.map((reason) => `- ${reason}`));
  } else {
    lines.push(t('decision:explain_no_reasons', undefined, locale));
  }
  if (view.recommendation) {
    lines.push(
      `${t('decision:recommendation_label', undefined, locale)}: ${t(CHOICE_KEY[view.recommendation.choice], undefined, locale)} — ${view.recommendation.rationale}`
    );
  }
  lines.push(`${t('decision:if_no_response_label', undefined, locale)}: ${view.ifNoResponse}`);
  if (view.evidence.length > 0) {
    lines.push(`${t('decision:evidence_label', undefined, locale)}:`);
    lines.push(...view.evidence.map((item) => `- ${item}`));
  }
  return lines.join('\n');
}
