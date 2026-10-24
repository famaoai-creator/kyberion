/**
 * CD-11: fixed customer message templates `sendToCustomer` may classify as
 * routine business (`routine_business`), so a tenant charter that delegates
 * `customer_outbound` lets them go out without a human approval.
 *
 * A message is routine only when its body is EXACTLY what the registered
 * template renders with the given parameters in the given locale — the
 * classification renders the template itself and compares; the caller's
 * claim is never trusted. Parameters are short, single-line and link-free
 * (a date must be `YYYY-MM-DD`), so a template cannot carry free content.
 * Anything else (an edited text, an unknown template, odd parameters) is not
 * routine and goes through the outbound approval gate as before.
 *
 * Registering a template here is the pre-approval: add one only for wording
 * that is safe to send unattended to a bound customer.
 */
import { t, type VocabularyKey } from './t.js';

interface CustomerRoutineTemplate {
  key: VocabularyKey;
  /**
   * Parameter names. `date` must be `YYYY-MM-DD`, `time` `HH:MM`, `zone` a
   * known zone label; any other parameter is free text checked by
   * {@link routineParamProblem}.
   */
  params: readonly string[];
}

export const CUSTOMER_ROUTINE_TEMPLATES: Readonly<Record<string, CustomerRoutineTemplate>> = {
  'customer_decision.reminder.before_due': {
    key: 'customer_decision:reminder_before_due',
    params: ['title', 'date'],
  },
  'customer_decision.reminder.due': {
    key: 'customer_decision:reminder_due',
    params: ['title', 'date'],
  },
  'customer_decision.reminder.override_closing': {
    key: 'customer_decision:reminder_override_closing',
    params: ['title', 'date', 'time', 'zone'],
  },
};

/** A message rendered from a registered template (passed to `sendToCustomer`). */
export interface CustomerRoutineTemplateRef {
  id: string;
  params: Readonly<Record<string, string>>;
  locale: 'ja' | 'en';
}

/** The agenda locales a template renders in (the agenda schema's `locale` enum). */
const TEMPLATE_LOCALES: ReadonlySet<string> = new Set(['ja', 'en']);
/** Same as the agenda schema's `title` limit. */
export const MAX_ROUTINE_PARAM_LENGTH = 300;
const DATE_PARAM = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_PARAM = /^\d{2}:\d{2}$/u;
const ZONE_PARAMS: ReadonlySet<string> = new Set(['UTC', 'JST']);
/** Control, format (bidi, zero-width), line and paragraph separators. */
const INVISIBLE_OR_BREAK = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A host name: labels joined by dots ending in a letter TLD (`acme.com`, `a.b.co`). */
const BARE_DOMAIN =
  /(?:^|[^\p{L}\p{N}_-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}_-])/u;
/** Chat mention / broadcast syntax (Slack, Discord, Telegram). */
const MENTION = /<[!@#]|@(?:everyone|here|channel)\b/iu;

/**
 * Why a free-text parameter cannot go into an unattended customer message,
 * or null: empty, too long, invisible / line-breaking characters, a link, a
 * bare domain or mention syntax — checked after NFKC folding, so fullwidth
 * `：／／` counts as `://`.
 */
export function routineParamProblem(name: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'empty';
  if (value.length > MAX_ROUTINE_PARAM_LENGTH) return 'too_long';
  if (name === 'date') return DATE_PARAM.test(value) ? null : 'not_a_date';
  if (name === 'time') return TIME_PARAM.test(value) ? null : 'not_a_time';
  if (name === 'zone') return ZONE_PARAMS.has(value) ? null : 'unknown_zone';
  if (INVISIBLE_OR_BREAK.test(value)) return 'invisible_or_break';
  const folded = value.normalize('NFKC').toLowerCase();
  if (INVISIBLE_OR_BREAK.test(folded)) return 'invisible_or_break';
  if (folded.includes('//') || folded.includes(':/') || folded.includes('www.')) return 'link';
  if (BARE_DOMAIN.test(folded)) return 'domain';
  if (MENTION.test(folded)) return 'mention';
  return null;
}

/**
 * The text a registered template renders to, or null when the reference is
 * not a registered template with exactly its parameters, each acceptable.
 */
export function renderCustomerRoutineTemplate(ref: CustomerRoutineTemplateRef): string | null {
  if (!ref || typeof ref.id !== 'string' || !Object.hasOwn(CUSTOMER_ROUTINE_TEMPLATES, ref.id))
    return null;
  if (!TEMPLATE_LOCALES.has(ref.locale)) return null;
  const template = CUSTOMER_ROUTINE_TEMPLATES[ref.id];
  const params = ref.params ?? {};
  const names = Object.keys(params);
  if (
    names.length !== template.params.length ||
    !template.params.every(
      (name) => Object.hasOwn(params, name) && routineParamProblem(name, params[name]) === null
    )
  )
    return null;
  return t(template.key, { ...params }, ref.locale);
}

/** Is `body` exactly the rendering of a registered template? */
export function isRenderedRoutineTemplate(
  body: string,
  ref: CustomerRoutineTemplateRef | undefined
): boolean {
  if (!ref) return false;
  const rendered = renderCustomerRoutineTemplate(ref);
  return rendered !== null && rendered === body;
}
