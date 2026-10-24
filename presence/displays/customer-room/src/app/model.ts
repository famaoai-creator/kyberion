/**
 * Customer-room client logic with no DOM and no I/O: the view contract, the
 * per-item draft, answer building/validation and failure mapping. The page
 * (`main.ts`) renders these; the unit tests drive them directly.
 */

export type RoomLocale = 'ja' | 'en';
export type EntryKind = 'choice' | 'approval' | 'ranking' | 'hearing';
export type AnswerChoice =
  'option' | 'keep' | 'free_text' | 'approve' | 'request_changes' | 'reject';

export interface ViewOption {
  label: string;
  value: unknown;
  impact?: { cost?: string; schedule?: string; scope?: string; rework?: string };
}

export interface ViewEntry {
  entry_id: string;
  kind: EntryKind;
  question: string;
  background?: string;
  options: ViewOption[];
  requires_customer: boolean;
  current: {
    status: string;
    layer: string;
    value?: unknown;
    /** Set when a customer answer is recorded but our team has not confirmed it yet. */
    awaiting_operator_confirmation?: boolean;
  };
  overridable: boolean;
  /** Approval entries: the draft value being approved. */
  draft?: unknown;
  /** Images shown with the item (fetched one by one through `/api/attachment`). */
  attachments?: ViewAttachment[];
  /** External links shown with the item (already https and non-internal). */
  links?: ViewLink[];
}

export type AttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ViewAttachment {
  id: string;
  name: string;
  media_type: AttachmentMediaType;
  bytes: number;
}

export interface ViewLink {
  label: string;
  url: string;
}

export interface ViewParticipant {
  name: string;
  role: 'decider' | 'contributor';
}

export interface ViewReceipt {
  receipt_id: string;
  submitted_at: string;
  revision: number;
  /** The agenda-wide question sent with that submission, when there was one. */
  general_question?: string;
}

export interface ViewOpen {
  ok: true;
  state: 'open';
  agenda: {
    title: string;
    locale: RoomLocale;
    revision: number;
    from?: string;
    /** UTC calendar date (YYYY-MM-DD) our team would like the answers by; only when set. */
    respond_by?: string;
  };
  participant: ViewParticipant;
  content_hash: string;
  entries: ViewEntry[];
  receipts: ViewReceipt[];
}

export interface ViewHeld {
  ok: true;
  state: 'updating' | 'closed';
  participant?: ViewParticipant;
}

export type ViewResult = ViewOpen | ViewHeld;

export interface AnswerPayload {
  entry_id: string;
  choice: AnswerChoice;
  value?: unknown;
  comment?: string;
}

/** What the person has entered for one item so far. */
export interface Draft {
  /** `option`: one of `optionIndex`; `keep`; `approve` / `request_changes` / `reject` for approvals. */
  choice?: 'option' | 'keep' | 'approve' | 'request_changes' | 'reject';
  optionIndex?: number;
  /** Ranking: option indices, in the order picked. */
  ranking: number[];
  text: string;
  comment: string;
}

export function emptyDraft(): Draft {
  return { ranking: [], text: '', comment: '' };
}

// ---------------------------------------------------------------------------
// Link fragment
// ---------------------------------------------------------------------------

const FRAGMENT_TOKEN = /^[A-Za-z0-9._-]{8,200}$/u;

/** The token from a `#t=...` fragment, or null when absent or malformed. */
export function parseFragmentToken(hash: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of body.split('&')) {
    if (part.startsWith('t=')) {
      const value = part.slice(2);
      return FRAGMENT_TOKEN.test(value) ? value : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

export const LOCALES: readonly RoomLocale[] = ['en', 'ja'];

function supportedLocale(value: string | undefined): RoomLocale | undefined {
  return LOCALES.find((locale) => locale === value);
}

/** The first supported language among the browser's, else English. */
export function localeFromBrowser(languages: readonly string[] | undefined): RoomLocale {
  for (const language of languages ?? []) {
    const found = supportedLocale(language.toLowerCase().split('-')[0]);
    if (found) return found;
  }
  return LOCALES[0];
}

export function pickLocale(
  agendaLocale: string | undefined,
  languages: readonly string[] | undefined
): RoomLocale {
  return supportedLocale(agendaLocale) ?? localeFromBrowser(languages);
}

// ---------------------------------------------------------------------------
// Current decision wording
// ---------------------------------------------------------------------------

export type SourceKey =
  | 'source_ours'
  | 'source_org_default'
  | 'source_customer'
  | 'source_customer_pending'
  | 'source_awaiting';

/** Whether the value in force is a customer answer our team has not confirmed yet. */
export function isPendingCustomer(current: ViewEntry['current']): boolean {
  return (
    current.layer === 'customer' &&
    (current.awaiting_operator_confirmation === true || current.status === 'provisional')
  );
}

export function sourceKey(current: ViewEntry['current']): SourceKey {
  if (current.value === undefined || current.status === 'awaiting_customer') {
    return 'source_awaiting';
  }
  if (current.layer === 'customer') {
    return isPendingCustomer(current) ? 'source_customer_pending' : 'source_customer';
  }
  if (current.layer === 'ours') return 'source_ours';
  if (current.layer === 'org_default') return 'source_org_default';
  return 'source_awaiting';
}

/** Stable comparison for option values (JSON values, key order independent). */
export function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export type ValueWording =
  | { kind: 'text'; text: string }
  | { kind: 'approved' }
  | { kind: 'changes_requested' }
  | { kind: 'rejected' }
  | { kind: 'none' };

/** How a stored value is shown: an option's label, free text, or an approval wording. */
export function describeValue(entry: ViewEntry, value: unknown): ValueWording {
  if (value === undefined || value === null) return { kind: 'none' };
  const matched = entry.options.find((option) => sameValue(option.value, value));
  if (matched) return { kind: 'text', text: matched.label };
  if (Array.isArray(value)) {
    const labels = value.map(
      (item) => entry.options.find((option) => sameValue(option.value, item))?.label
    );
    return labels.every((label) => typeof label === 'string')
      ? { kind: 'text', text: (labels as string[]).join(' > ') }
      : { kind: 'none' };
  }
  if (typeof value === 'string')
    return value.trim() ? { kind: 'text', text: value } : { kind: 'none' };
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'text', text: String(value) };
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.approved === true) return { kind: 'approved' };
    if (record.approved === false) {
      return record.rejected === true ? { kind: 'rejected' } : { kind: 'changes_requested' };
    }
  }
  return { kind: 'none' };
}

export type DraftView =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'pairs'; pairs: Array<[string, string]> }
  /** `{approved: true}`: "accept as delivered", shown in words, never as a raw row. */
  | { kind: 'accept' }
  | { kind: 'none' };

function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

/** How an approval's draft is shown: a sentence, a list, or label/value rows. */
export function describeDraft(draft: unknown): DraftView {
  if (draft === undefined || draft === null) return { kind: 'none' };
  if (Array.isArray(draft)) {
    const items = draft.map(plain).filter((item) => item.trim());
    return items.length > 0 ? { kind: 'list', items } : { kind: 'none' };
  }
  if (typeof draft === 'object') {
    const record = draft as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && record.approved === true) return { kind: 'accept' };
    const pairs = Object.entries(draft as Record<string, unknown>)
      .map(([key, value]): [string, string] => [key, plain(value)])
      .filter(([, value]) => value.trim());
    return pairs.length > 0 ? { kind: 'pairs', pairs } : { kind: 'none' };
  }
  const text = plain(draft);
  return text.trim() ? { kind: 'text', text } : { kind: 'none' };
}

/** True when a submitted answer to an item that needs the customer still needs our confirmation. */
export function needsOurConfirmation(
  entries: readonly ViewEntry[],
  answers: readonly AnswerPayload[]
): boolean {
  return answers.some(
    (answer) => entries.find((entry) => entry.entry_id === answer.entry_id)?.requires_customer
  );
}

export function keepAvailable(entry: ViewEntry): boolean {
  return (
    entry.current.value !== undefined && describeValue(entry, entry.current.value).kind !== 'none'
  );
}

// ---------------------------------------------------------------------------
// Attachments and links
// ---------------------------------------------------------------------------

export const ATTACHMENT_MEDIA_TYPES: readonly AttachmentMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];
export const MAX_ATTACHMENT_BYTES = 512 * 1024;
const ATTACHMENT_ID = /^[a-f0-9]{64}$/u;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isAttachmentMediaType(value: unknown): value is AttachmentMediaType {
  return ATTACHMENT_MEDIA_TYPES.some((type) => type === value);
}

/** The item's images that can be fetched; anything malformed is left out. */
export function entryAttachments(entry: Pick<ViewEntry, 'attachments'>): ViewAttachment[] {
  if (!Array.isArray(entry.attachments)) return [];
  const items: unknown[] = entry.attachments;
  return items.filter(
    (item): item is ViewAttachment =>
      isRecordValue(item) &&
      typeof item.id === 'string' &&
      ATTACHMENT_ID.test(item.id) &&
      typeof item.name === 'string' &&
      isAttachmentMediaType(item.media_type) &&
      typeof item.bytes === 'number' &&
      Number.isFinite(item.bytes) &&
      item.bytes > 0 &&
      item.bytes <= MAX_ATTACHMENT_BYTES
  );
}

export interface ShownLink {
  label: string;
  href: string;
  host: string;
}

/** The item's links that are https with a host; the host is shown next to the label. */
export function entryLinks(entry: Pick<ViewEntry, 'links'>): ShownLink[] {
  if (!Array.isArray(entry.links)) return [];
  const shown: ShownLink[] = [];
  const items: unknown[] = entry.links;
  for (const item of items) {
    if (!isRecordValue(item) || typeof item.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) continue;
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : '';
    shown.push({ label: label || url.hostname, href: url.href, host: url.hostname });
  }
  return shown;
}

/** A file size in KB (at least 1), in the page language. */
export function formatSize(bytes: number, locale: RoomLocale): string {
  const kb = Math.max(1, Math.round(bytes / 1024));
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'kilobyte',
    maximumFractionDigits: 0,
  }).format(kb);
}

// ---------------------------------------------------------------------------
// Drafts -> answers
// ---------------------------------------------------------------------------

export type DraftIssue = 'comment_required' | 'reason_required' | 'selection_invalid';

export interface BuiltAnswers {
  answers: AnswerPayload[];
  issues: Array<{ entry_id: string; issue: DraftIssue }>;
}

/** Vocabulary key of the inline help for a draft issue. */
export function issueMessageKey(
  issue: DraftIssue
): 'comment_missing' | 'reject_reason_missing' | 'selection_invalid' {
  if (issue === 'comment_required') return 'comment_missing';
  if (issue === 'reason_required') return 'reject_reason_missing';
  return 'selection_invalid';
}

/** Choices whose comment is required (and where it is shown as required). */
export function commentRequired(choice: Draft['choice']): boolean {
  return choice === 'request_changes' || choice === 'reject';
}

function withComment(answer: AnswerPayload, comment: string): AnswerPayload {
  const text = comment.trim();
  return text ? { ...answer, comment: text } : answer;
}

/** The answer for one item, or null when nothing was entered. */
export function buildAnswer(
  entry: ViewEntry,
  draft: Draft
): { answer: AnswerPayload } | { issue: DraftIssue } | null {
  const comment = draft.comment.trim();
  const base = { entry_id: entry.entry_id };
  switch (draft.choice) {
    case 'keep':
      return keepAvailable(entry)
        ? { answer: withComment({ ...base, choice: 'keep' }, comment) }
        : { issue: 'selection_invalid' };
    case 'approve':
      return entry.kind === 'approval'
        ? { answer: withComment({ ...base, choice: 'approve' }, comment) }
        : { issue: 'selection_invalid' };
    case 'request_changes':
      if (entry.kind !== 'approval') return { issue: 'selection_invalid' };
      return comment
        ? { answer: { ...base, choice: 'request_changes', comment } }
        : { issue: 'comment_required' };
    case 'reject':
      if (entry.kind !== 'approval') return { issue: 'selection_invalid' };
      return comment
        ? { answer: { ...base, choice: 'reject', comment } }
        : { issue: 'reason_required' };
    case 'option': {
      const option = draft.optionIndex === undefined ? undefined : entry.options[draft.optionIndex];
      return option
        ? { answer: withComment({ ...base, choice: 'option', value: option.value }, comment) }
        : { issue: 'selection_invalid' };
    }
    default:
      break;
  }
  if (entry.kind === 'ranking' && draft.ranking.length > 0) {
    const values = draft.ranking.map((index) => entry.options[index]?.value);
    return values.some((value) => value === undefined)
      ? { issue: 'selection_invalid' }
      : { answer: withComment({ ...base, choice: 'option', value: values }, comment) };
  }
  if (entry.kind === 'hearing' && draft.text.trim()) {
    return {
      answer: withComment({ ...base, choice: 'free_text', value: draft.text.trim() }, comment),
    };
  }
  // A comment alone is still an answer (a note for our team).
  if (comment) return { answer: { ...base, choice: 'free_text', comment } };
  return null;
}

export function buildAnswers(
  entries: readonly ViewEntry[],
  drafts: Map<string, Draft>
): BuiltAnswers {
  const answers: AnswerPayload[] = [];
  const issues: BuiltAnswers['issues'] = [];
  for (const entry of entries) {
    const draft = drafts.get(entry.entry_id);
    if (!draft) continue;
    const built = buildAnswer(entry, draft);
    if (!built) continue;
    if ('answer' in built) answers.push(built.answer);
    else issues.push({ entry_id: entry.entry_id, issue: built.issue });
  }
  return { answers, issues };
}

// ---------------------------------------------------------------------------
// Answer target date
// ---------------------------------------------------------------------------

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** The year, month and day of a real `YYYY-MM-DD` date, or null. */
function parseCalendarDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== 'string') return null;
  const match = CALENDAR_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
    ? { year, month, day }
    : null;
}

/**
 * The target date as a calendar date in the page language ("October 30" /
 * "10月30日"). It is a date, not a moment: no timezone shift is applied. The
 * year is added only when it is not the current one. Null when malformed.
 */
export function formatRespondBy(
  value: unknown,
  locale: RoomLocale,
  currentYear: number
): string | null {
  const parts = parseCalendarDate(value);
  if (!parts) return null;
  const moment = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    ...(parts.year === currentYear ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
  }).format(moment);
}

/** True when the target date is before `today` (both `YYYY-MM-DD`, compared as calendar dates). */
export function isRespondByPast(value: unknown, today: string): boolean {
  return parseCalendarDate(value) !== null && parseCalendarDate(today) !== null
    ? (value as string) < today
    : false;
}

/** The viewer's own calendar date (`YYYY-MM-DD`). */
export function localCalendarDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// General question (anything else the person wants to ask)
// ---------------------------------------------------------------------------

export const GENERAL_QUESTION_MAX = 10000;

/** The trimmed question to send, or why it cannot be sent; blank means none. */
export function normalizeGeneralQuestion(
  text: string
): { question?: string } | { issue: 'general_too_long' } {
  const question = text.trim();
  if (question.length > GENERAL_QUESTION_MAX) return { issue: 'general_too_long' };
  return question ? { question } : {};
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type ScreenState =
  | 'updating'
  | 'closed'
  | 'expired'
  | 'revoked'
  | 'invalid_link'
  | 'not_entitled'
  | 'stale'
  | 'unavailable';

/** Maps a facade/server reason code to the plain screen to show (never the code itself). */
export function screenForReason(reason: unknown): ScreenState {
  switch (reason) {
    case 'updating':
    case 'closed':
    case 'expired':
    case 'revoked':
    case 'invalid_link':
    case 'not_entitled':
      return reason;
    case 'stale_version':
      return 'stale';
    default:
      return 'unavailable';
  }
}
