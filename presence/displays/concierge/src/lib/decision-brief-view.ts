import { localeToBcp47 } from '@agent/core/locale-normalize';
import type { DecisionBrief, DisplayText } from '@agent/core/surface/decision-brief';
import { describeActor, humanizeSummary } from '@agent/core/surface/display-humanize';
import { conciergeText, type ConciergeLocale, type ConciergeMessageKey } from './i18n';

/**
 * Client half of the decision brief (`@agent/core/surface/decision-brief`):
 * validates the brief the server sent, renders its vocabulary keys, and maps
 * the non-approval decision kinds (stalled missions, learnings, deliverables,
 * exceptions) to the same "what to decide / what each answer does" shape.
 * Pure: no fetch, no React.
 */

export type { DecisionBrief, DisplayText } from '@agent/core/surface/decision-brief';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

export function formatInstant(value: string, locale: ConciergeLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(localeToBcp47(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Renders a brief line: a concierge vocabulary key (params with ISO instants formatted) or text. */
export function renderDisplayText(text: DisplayText, locale: ConciergeLocale): string {
  if ('text' in text) return text.text;
  const params = Object.fromEntries(
    Object.entries(text.params ?? {}).map(([name, value]) => [
      name,
      typeof value === 'string' && ISO_INSTANT.test(value) ? formatInstant(value, locale) : value,
    ])
  );
  return conciergeText(text.key as ConciergeMessageKey, locale, params);
}

/** An actor id as a person reads it (member / agent name, or "自動処理（…）"). */
export function actorDisplayName(
  actorId: string,
  locale: ConciergeLocale,
  knownLabel?: string
): string {
  return renderDisplayText(
    describeActor(actorId, knownLabel ? () => knownLabel : undefined),
    locale
  );
}

/** Card body text with hashes, paths and JSON removed and clamped to ~2 lines. */
export function cardSummary(text: string | undefined, maxChars?: number) {
  return humanizeSummary(text, maxChars);
}

function isDisplayText(value: unknown): value is DisplayText {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return true;
  // Brief keys are concierge vocabulary: `ux_a_*` copy and `ux_b_reason_*` gate reasons.
  if (typeof record.key !== 'string' || !/^ux_[ab]_/u.test(record.key)) return false;
  if (record.params === undefined) return true;
  return (
    typeof record.params === 'object' &&
    record.params !== null &&
    Object.values(record.params).every((v) => typeof v === 'string' || typeof v === 'number')
  );
}

const STATES = new Set(['pending', 'resolved', 'expired']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);

/** Accepts a well-formed brief; anything else is dropped (the card keeps its title). */
export function parseDecisionBrief(value: unknown): DecisionBrief | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const b = value as Record<string, unknown>;
  if (
    !isDisplayText(b.ask) ||
    !Array.isArray(b.why) ||
    !b.why.every(isDisplayText) ||
    !isDisplayText(b.onApprove) ||
    !isDisplayText(b.onReject) ||
    !isDisplayText(b.ifSilent) ||
    !isDisplayText(b.requester) ||
    typeof b.state !== 'string' ||
    !STATES.has(b.state) ||
    typeof b.groupKey !== 'string' ||
    !Array.isArray(b.details) ||
    !b.details.every(
      (row) =>
        row &&
        typeof row === 'object' &&
        typeof (row as { labelKey?: unknown }).labelKey === 'string' &&
        typeof (row as { value?: unknown }).value === 'string'
    ) ||
    (b.recommendation !== undefined && !isDisplayText(b.recommendation)) ||
    (b.risk !== undefined && !(typeof b.risk === 'string' && RISKS.has(b.risk))) ||
    (b.reversible !== undefined && typeof b.reversible !== 'boolean') ||
    (b.deadline !== undefined && typeof b.deadline !== 'string') ||
    (b.askFull !== undefined && typeof b.askFull !== 'string') ||
    (b.effectId !== undefined && typeof b.effectId !== 'string')
  )
    return undefined;
  return value as DecisionBrief;
}

/** One answer the person can give and what it does. `labelKey` is the button's front-desk key. */
export interface KindImpact {
  labelKey:
    | 'decide_continue'
    | 'decide_stop'
    | 'decide_remember'
    | 'decide_forget'
    | 'decide_receive'
    | 'decide_return';
  effect: DisplayText;
}

export interface KindBrief {
  ask: DisplayText;
  impacts: KindImpact[];
}

/** The decide-queue kinds that have no server brief, in the same plain shape. */
export function kindBrief(kind: 'hygiene' | 'memory' | 'outcome' | 'exception'): KindBrief {
  switch (kind) {
    case 'hygiene':
      return {
        ask: { key: 'ux_a_hygiene_ask' },
        impacts: [
          { labelKey: 'decide_continue', effect: { key: 'ux_a_hygiene_on_continue' } },
          { labelKey: 'decide_stop', effect: { key: 'ux_a_hygiene_on_stop' } },
        ],
      };
    case 'memory':
      return {
        ask: { key: 'ux_a_memory_ask' },
        impacts: [
          { labelKey: 'decide_remember', effect: { key: 'ux_a_memory_on_keep' } },
          { labelKey: 'decide_forget', effect: { key: 'ux_a_memory_on_forget' } },
        ],
      };
    case 'outcome':
      return {
        ask: { key: 'ux_a_outcome_ask' },
        impacts: [
          { labelKey: 'decide_receive', effect: { key: 'ux_a_outcome_on_accept' } },
          { labelKey: 'decide_return', effect: { key: 'ux_a_outcome_on_return' } },
        ],
      };
    default:
      return { ask: { key: 'ux_a_exception_ask' }, impacts: [] };
  }
}
