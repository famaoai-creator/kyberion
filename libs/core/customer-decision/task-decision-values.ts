/**
 * CD-09: the confirmed customer decision values a resumed task receives
 * (human decision 2026-10-25: only the task's own `requires_customer`
 * questions). The values are confidential tenant data that the decision lock
 * reads in memory; this holder carries them from the pin to the task prompt
 * and nowhere else.
 *
 *   - serialized (`JSON.stringify`, `util.inspect`, a log line, a WorkItem
 *     metadata spread) it shows `{ count, decision_ids }` only;
 *   - `promptLines()` renders the one prompt section that carries the values;
 *   - `scrub(text)` replaces echoed values in worker output before it reaches
 *     a store that is not tenant-partitioned (work coordination, public
 *     mission evidence).
 */
import type { ResolvedTaskProposalDecision } from './consumption.js';

/** Shorter forms are scrubbed only as words of their own (see `scrub`). */
export const TASK_DECISION_SCRUB_MIN_LENGTH = 4;

export const CONFIRMED_CUSTOMER_DECISIONS_HEADING =
  '## Confirmed customer decisions (confidential — use them, do not restate the values in summary/needs/gaps; cite the decision id)';

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

export interface TaskDecisionValuesCase {
  tenantSlug: string;
  caseId: string;
  consumer: string;
  projectId?: string;
}

/** What serializing the holder shows: ids only. */
export interface TaskDecisionValuesSummary {
  count: number;
  decision_ids: string[];
  unconfirmed_proposal_ids?: string[];
}

/** A completed-lock proposal whose release has no value to deliver any more. */
export interface UnconfirmedTaskProposal {
  proposal_id: string;
  reason: 'changed_after_completion' | 'decision_not_recorded';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

/** A replacement already made; never matched again (scrub is idempotent). */
const MARKER_SOURCE = '\\[customer decision [A-Za-z0-9._:#-]+\\]';
const MARKER = new RegExp(`^${MARKER_SOURCE}$`, 'u');

/**
 * The parts of a task result that are not free text and stay as written:
 * the worker's own proposals (they go to the confidential decision lock),
 * artifact paths and kinds, the provenance stamp, the knowledge paths it
 * reports, and enum fields. Paths are object keys joined by `.` (array
 * positions are not part of them).
 */
export const TASK_RESULT_SCRUB_SKIP_KEYS: readonly string[] = [
  'customer_decisions',
  'artifacts',
  'provenance',
  'knowledge_feedback.used',
  'knowledge_feedback.not_used',
  'review_findings.severity',
  'acceptance_evidence.status',
];

/** Character classes that make one word: CJK scripts each on their own, else letters and digits. */
const WORD_CLASSES = [
  '\\p{Script=Han}',
  '\\p{Script=Hiragana}',
  '\\p{Script=Katakana}',
  '(?:(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}])[\\p{L}\\p{N}_])',
];

function wordClassOf(char: string | undefined): string | null {
  if (!char) return null;
  return WORD_CLASSES.find((cls) => new RegExp(`^${cls}$`, 'u').test(char)) ?? null;
}

/** `needle` as a word of its own: no neighbor of the same word class as its edge character. */
function wordPattern(needle: string): string {
  const chars = [...needle];
  const before = wordClassOf(chars[0]);
  const after = wordClassOf(chars[chars.length - 1]);
  return `${before ? `(?<!${before})` : ''}${escapeRegExp(needle)}${after ? `(?!${after})` : ''}`;
}

function scrubDeep(
  value: unknown,
  scrub: (text: string) => string,
  skipPaths: ReadonlySet<string>,
  path: string,
  depth: number
): unknown {
  if (typeof value === 'string') return scrub(value);
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, scrub, skipPaths, path, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    out[key] = skipPaths.has(keyPath)
      ? item
      : scrubDeep(item, scrub, skipPaths, keyPath, depth + 1);
  }
  return out;
}

/** String and number leaves of a decision value (objects and arrays walked). */
function scalarLeaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' && Number.isFinite(value)) out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) scalarLeaves(item, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) scalarLeaves(item, out, depth + 1);
  }
}

export class ConfidentialTaskDecisionValues {
  readonly #case: TaskDecisionValuesCase;
  readonly #items: readonly ResolvedTaskProposalDecision[];
  readonly #unconfirmed: readonly UnconfirmedTaskProposal[];

  constructor(
    decisionCase: TaskDecisionValuesCase,
    items: readonly ResolvedTaskProposalDecision[],
    /** Completed-lock proposals with no value to deliver (ids and why only). */
    unconfirmed: readonly UnconfirmedTaskProposal[] = []
  ) {
    this.#case = { ...decisionCase };
    this.#items = items.map((item) => ({ ...item }));
    this.#unconfirmed = unconfirmed.map((item) => ({ ...item }));
  }

  /** Decisions whose values are held (confidential). */
  get count(): number {
    return this.#items.length;
  }

  /** Nothing to put in the prompt: no value and no unconfirmed proposal. */
  get isEmpty(): boolean {
    return this.#items.length === 0 && this.#unconfirmed.length === 0;
  }

  /** Proposals the task is told it has no confirmed value for (ids only), sorted. */
  get unconfirmedProposalIds(): string[] {
    return [...new Set(this.#unconfirmed.map((item) => item.proposal_id))].sort();
  }

  /** Why those proposals have no value (`changed_after_completion`, …), sorted and unique. */
  get unconfirmedReasons(): string[] {
    return [...new Set(this.#unconfirmed.map((item) => item.reason))].sort();
  }

  get tenantSlug(): string {
    return this.#case.tenantSlug;
  }

  get caseId(): string {
    return this.#case.caseId;
  }

  get consumer(): string {
    return this.#case.consumer;
  }

  get projectId(): string | undefined {
    return this.#case.projectId;
  }

  /** Ledger ids of the decisions held, sorted and unique. */
  get decisionIds(): string[] {
    return [...new Set(this.#items.map((item) => item.decision_id))].sort();
  }

  /**
   * `customer-decision:<case>#<decision_id>` refs (and `#<proposal_id>` for
   * an unconfirmed proposal) for metadata-only records.
   */
  knowledgeRefs(): string[] {
    return [...this.decisionIds, ...this.unconfirmedProposalIds].map(
      (id) => `customer-decision:${this.#case.caseId}#${id}`
    );
  }

  toJSON(): TaskDecisionValuesSummary {
    return {
      count: this.count,
      decision_ids: this.decisionIds,
      ...(this.#unconfirmed.length > 0
        ? { unconfirmed_proposal_ids: this.unconfirmedProposalIds }
        : {}),
    };
  }

  [INSPECT_CUSTOM](): TaskDecisionValuesSummary {
    return this.toJSON();
  }

  toString(): string {
    return `[customer decisions ${this.decisionIds.join(', ')}]`;
  }

  /** The prompt section carrying the values (empty when there is nothing to say). */
  promptLines(): string[] {
    if (this.isEmpty) return [];
    return [
      CONFIRMED_CUSTOMER_DECISIONS_HEADING,
      ...this.#items.map((item) => {
        const label = item.option_label ? ` (option: ${item.option_label})` : '';
        return `- [${item.decision_id}] ${item.question} (${item.item} / ${item.key}) → ${JSON.stringify(item.value)}${label}`;
      }),
      ...this.#unconfirmed.map((item) =>
        item.reason === 'changed_after_completion'
          ? `- The decision for ${item.proposal_id} changed after this task completed and is not confirmed; do not assume a value (put it in needs if the work depends on it).`
          : `- The decision for ${item.proposal_id} is no longer recorded; do not assume a value (put it in needs if the work depends on it).`
      ),
      ...(this.#items.length > 0
        ? [
            'These are the customer’s confirmed answers to the questions this task asked; build on them. Refer to a decision only by its id in summary, needs and gaps.',
          ]
        : []),
      '',
    ];
  }

  /**
   * Replace echoed values (string / number forms, option labels, JSON forms)
   * with their decision id, case-insensitively. A form of
   * {@link TASK_DECISION_SCRUB_MIN_LENGTH} characters or more is replaced
   * wherever it appears; a shorter one ("yes", "A", "5%", "はい") only as a
   * word of its own, so it never rewrites part of a longer word ("yesterday",
   * "Apple", "15%", "はいけい"). One pass over the text: a marker already in
   * it (`[customer decision <id>]`) is kept as it is, so scrubbing twice
   * changes nothing, and no other character of the text is touched.
   */
  scrub(text: string): string {
    if (!text || this.#items.length === 0) return text;
    const needles: Array<{ needle: string; id: string }> = [];
    for (const item of this.#items) {
      const forms: string[] = [];
      scalarLeaves(item.value, forms);
      if (item.option_label) forms.push(item.option_label);
      if (typeof item.value !== 'string') {
        try {
          forms.push(JSON.stringify(item.value));
        } catch {
          // A value that cannot be serialized has no echoed JSON form.
        }
      }
      for (const form of forms) {
        const trimmed = form.trim();
        if (trimmed) needles.push({ needle: trimmed, id: item.decision_id });
      }
    }
    if (needles.length === 0) return text;
    // Longest first, so a longer form wins over a shorter one inside it.
    needles.sort((a, b) => b.needle.length - a.needle.length);
    const idOf = new Map<string, string>();
    for (const { needle, id } of needles) {
      if (!idOf.has(needle.toLowerCase())) idOf.set(needle.toLowerCase(), id);
    }
    const alternatives = needles.map(({ needle }) =>
      needle.length >= TASK_DECISION_SCRUB_MIN_LENGTH ? escapeRegExp(needle) : wordPattern(needle)
    );
    const pattern = new RegExp([MARKER_SOURCE, ...alternatives].join('|'), 'giu');
    return text.replace(pattern, (match) =>
      MARKER.test(match) ? match : `[customer decision ${idOf.get(match.toLowerCase()) ?? 'id'}]`
    );
  }

  /**
   * A deep copy of `value` with {@link scrub} applied to every string in it
   * (keys are kept). What sits under a path in `skipPaths` (object keys
   * joined by `.`) is copied unchanged.
   */
  scrubValue<T>(value: T, skipPaths: readonly string[] = []): T {
    return scrubDeep(value, (text) => this.scrub(text), new Set(skipPaths), '', 0) as T;
  }
}

/**
 * Scrub a worker response before any copy of it is stored: the task result
 * is replaced by a scrubbed copy (every free-text string;
 * {@link TASK_RESULT_SCRUB_SKIP_KEYS} stay as written — the caller keeps the
 * original for its in-memory checks), the notes and parse errors in place.
 */
export function scrubTaskResponseValues(
  values: ConfidentialTaskDecisionValues,
  response: {
    taskResult?: object;
    notes?: string[];
    parseErrors?: string[];
    surfaceParseErrors?: string[];
  }
): void {
  if (response.taskResult) {
    response.taskResult = values.scrubValue(response.taskResult, TASK_RESULT_SCRUB_SKIP_KEYS);
  }
  for (const key of ['notes', 'parseErrors', 'surfaceParseErrors'] as const) {
    const list = response[key];
    if (Array.isArray(list))
      list.splice(0, list.length, ...list.map((entry) => values.scrub(String(entry))));
  }
}
