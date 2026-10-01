import type { ApprovalRequestRecord } from './approval-store.js';
import { evaluateVetoWindow, type VetoWindowState } from './approval-veto-window.js';
import type { AutonomousOpsGateResult } from './autonomous-ops-gate.js';
import type { DecisionCard, DecisionCardEvidence, InterventionLevel } from './decision-card.js';
import type { NotificationChannelTarget } from '../surface/operator-notifications.js';
import { resolveLocale } from '../locale.js';
import { localeToBcp47, localeUsesWordSpaces, type SupportedLocale } from '../locale-normalize.js';
import { t, type VocabularyKey } from '../t.js';

export type { InterventionLevel } from './decision-card.js';

/**
 * Autonomous-operation P1-6: one answer to "do I need to do anything?".
 *
 * The stored card (`decision-card.ts`) says what is asked; this module says
 * what the operator has to do about it. Every decision falls into one of four
 * intervention levels, derived from the autonomous-ops gate — never chosen by
 * the acting agent:
 *
 * | level    | gate                           | the operator …                       | phone rings? |
 * | -------- | ------------------------------ | ------------------------------------ | ------------ |
 * | `none`   | auto                           | does nothing; it is in the digest    | no           |
 * | `fyi`    | notify                         | does nothing; reads it in the digest | no           |
 * | `veto`   | notify + `veto_window_minutes` | acts only to object before deadline  | yes, once    |
 * | `decide` | approve                        | must decide; the work waits          | yes, once    |
 *
 * The rendered card always states what happens if the operator does nothing,
 * so the operator never has to infer whether silence blocks, delays or approves.
 */

export type InterventionTiming = 'immediate' | 'digest';

/** Storage channel for decisions raised by autonomous operations. */
export const AUTONOMY_APPROVAL_CHANNEL = 'autonomy';

export const INTERVENTION_LEVELS: readonly InterventionLevel[] = ['decide', 'veto', 'fyi', 'none'];

export interface DecisionCardView {
  requestId: string;
  title: string;
  level: InterventionLevel;
  question: string;
  recommendation?: string;
  reasons: string[];
  reversible: boolean;
  evidence: DecisionCardEvidence[];
  shadow: boolean;
  vetoState?: VetoWindowState;
  /** The instant that changes the outcome: when a veto proceeds or a decision expires. */
  deadlineAt?: string;
  ifNoResponse: string;
}

const LEVEL_KEY: Record<InterventionLevel, VocabularyKey> = {
  decide: 'decision:level_decide',
  veto: 'decision:level_veto',
  fyi: 'decision:level_fyi',
  none: 'decision:level_none',
};

export function interventionLevelLabel(
  level: InterventionLevel,
  locale: SupportedLocale = resolveLocale()
): string {
  return t(LEVEL_KEY[level], undefined, locale);
}

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

export function formatDecisionInstant(
  iso: string,
  locale: SupportedLocale = resolveLocale(),
  timezone?: string
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(localeToBcp47(locale), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(ms));
}

function levelFromTier(card: DecisionCard): InterventionLevel {
  if (card.level) return card.level;
  if (card.riskTier === 'approve') return 'decide';
  return card.riskTier === 'notify' ? 'fyi' : 'none';
}

/**
 * The effective level of a stored request right now. A pending request with
 * no card is a human approval, so it reads as `decide`; a veto whose
 * notification never arrived also becomes `decide`.
 */
export function effectiveInterventionLevel(
  record: Pick<ApprovalRequestRecord, 'decisionCard' | 'veto'>,
  now = Date.now()
): InterventionLevel {
  if (record.veto) {
    return evaluateVetoWindow(record.veto, now) === 'undelivered' ? 'decide' : 'veto';
  }
  return record.decisionCard ? levelFromTier(record.decisionCard) : 'decide';
}

const ACTION_LABEL_KEY: Record<
  'approve' | 'changes' | 'reject' | 'explain',
  { decide: VocabularyKey; veto: VocabularyKey }
> = {
  approve: { decide: 'decision:action_approve', veto: 'decision:action_proceed_now' },
  changes: { decide: 'decision:action_revise', veto: 'decision:action_revise' },
  reject: { decide: 'decision:action_reject', veto: 'decision:action_object' },
  explain: { decide: 'decision:action_explain', veto: 'decision:action_explain' },
};

/** Button label for a card action; on a veto card "approve" means proceed now and "reject" means object. */
export function decisionCardActionLabel(
  record: Pick<ApprovalRequestRecord, 'decisionCard' | 'veto'>,
  kind: keyof typeof ACTION_LABEL_KEY,
  locale: SupportedLocale = resolveLocale()
): string {
  const level = effectiveInterventionLevel(record);
  return t(ACTION_LABEL_KEY[kind][level === 'veto' ? 'veto' : 'decide'], undefined, locale);
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
  const deadline = record.decisionCard?.deadline ?? record.expiresAt;
  if (deadline) {
    lines.push(
      t(
        'decision:if_no_response_decide_expires',
        { deadline: formatDecisionInstant(deadline, locale, timezone) },
        locale
      )
    );
  }
  return {
    text: lines.join(localeUsesWordSpaces(locale) ? ' ' : ''),
    ...(deadline ? { deadlineAt: deadline } : {}),
  };
}

/**
 * Locale for a card that may have no inbound message to follow (a proactive
 * push): the turn's reply locale when one is active, else the locale stored
 * for the approval's tenant / organization / project scope, else the
 * operator's (identity language, `KYBERION_LOCALE`, catalog default).
 */
export function resolveApprovalLocale(
  record: Pick<ApprovalRequestRecord, 'scope'>,
  explicit?: SupportedLocale
): SupportedLocale {
  return explicit ?? resolveLocale({ scope: record.scope });
}

export function viewDecisionCard(
  record: ApprovalRequestRecord,
  options: { now?: number; locale?: SupportedLocale } = {}
): DecisionCardView {
  const now = options.now ?? Date.now();
  const locale = resolveApprovalLocale(record, options.locale);
  const card = record.decisionCard;
  const level = effectiveInterventionLevel(record, now);
  const vetoState = record.veto ? evaluateVetoWindow(record.veto, now) : undefined;
  const noResponse = describeIfNoResponse(record, level, vetoState, locale);
  const reasons = [
    ...(card?.riskReasons ?? []),
    ...(record.justification?.reason && !card?.riskReasons.includes(record.justification.reason)
      ? [record.justification.reason]
      : []),
  ];
  return {
    requestId: record.id,
    title: record.title,
    level,
    question: card?.question ?? record.summary,
    ...(card?.recommendation ? { recommendation: card.recommendation } : {}),
    reasons,
    // Unknown reversibility is reported as irreversible: the safe reading.
    reversible: card?.reversible ?? false,
    evidence: card?.evidence ?? [],
    shadow: Boolean(card?.shadow || record.veto?.shadow),
    ...(vetoState ? { vetoState } : {}),
    ...(noResponse.deadlineAt ? { deadlineAt: noResponse.deadlineAt } : {}),
    ifNoResponse: noResponse.text,
  };
}

function evidenceLine(item: DecisionCardEvidence): string {
  return `- ${item.label}: ${item.ref}`;
}

/**
 * The card body shared by every surface, in a fixed order so the operator
 * learns where to look: level → question → recommendation → why → undo →
 * if-no-response → evidence.
 */
export function renderDecisionCardLines(
  view: DecisionCardView,
  locale: SupportedLocale = resolveLocale()
): string[] {
  const lines = [
    `${interventionLevelLabel(view.level, locale)}${
      view.shadow ? ` ${t('decision:shadow_badge', undefined, locale)}` : ''
    }`,
    view.title,
    '',
    `${t('decision:ask_label', undefined, locale)}: ${view.question}`,
  ];
  if (view.recommendation) {
    lines.push(`${t('decision:recommendation_label', undefined, locale)}: ${view.recommendation}`);
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
    lines.push(
      `${t('decision:evidence_label', undefined, locale)}:`,
      ...view.evidence.map(evidenceLine)
    );
  }
  return lines;
}

/** Plain-text card for chat surfaces, with the reply vocabulary when a reply matters. */
export function renderDecisionCardText(
  view: DecisionCardView,
  locale: SupportedLocale = resolveLocale()
): string {
  const lines = renderDecisionCardLines(view, locale);
  if (view.level === 'decide' || view.level === 'veto') {
    lines.push('', t('decision:reply_hint', { requestId: view.requestId }, locale));
  }
  return lines.join('\n');
}

/** The "ask why" answer: the stored reasons, recommendation and evidence — never a model call. */
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
    lines.push(`${t('decision:recommendation_label', undefined, locale)}: ${view.recommendation}`);
  }
  lines.push(`${t('decision:if_no_response_label', undefined, locale)}: ${view.ifNoResponse}`);
  if (view.evidence.length > 0) {
    lines.push(
      `${t('decision:evidence_label', undefined, locale)}:`,
      ...view.evidence.map(evidenceLine)
    );
  }
  return lines.join('\n');
}

/**
 * Outbox notifications are sent with each surface's default formatting (Slack
 * mrkdwn, Telegram Markdown, Discord markdown), so agent-written text in a card
 * could otherwise plant a disguised link or a mass mention on the decision
 * screen. Neutralize the syntax that changes what the operator sees.
 */
export function neutralizeSurfaceMarkup(
  text: string,
  surface: NotificationChannelTarget['surface']
): string {
  switch (surface) {
    case 'slack':
      return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    case 'telegram':
      // Legacy Markdown: only these four characters can be escaped.
      return text.replace(/[_*`[]/gu, (char) => `\\${char}`);
    case 'discord':
      return text
        .replace(/[\\*_~`|[\]()<>]/gu, (char) => `\\${char}`)
        .replace(/@(everyone|here)/giu, '@\u200b$1');
    default:
      return text;
  }
}
