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
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

const TOKEN_OPEN = '\uE000';
const TOKEN_CLOSE = '\uE001';
const TOKEN_INDEX_BASE = 0xe100;
const TOKEN_PATTERN = /\uE000([\uE100-\uF8FF])\uE001/gu;

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
  skipKeys: ReadonlySet<string>,
  depth: number
): unknown {
  if (typeof value === 'string') return scrub(value);
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub, skipKeys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = skipKeys.has(key) ? item : scrubDeep(item, scrub, skipKeys, depth + 1);
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

  constructor(
    decisionCase: TaskDecisionValuesCase,
    items: readonly ResolvedTaskProposalDecision[]
  ) {
    this.#case = { ...decisionCase };
    this.#items = items.map((item) => ({ ...item }));
  }

  get count(): number {
    return this.#items.length;
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

  /** `customer-decision:<case>#<decision_id>` refs for metadata-only records. */
  knowledgeRefs(): string[] {
    return this.decisionIds.map((id) => `customer-decision:${this.#case.caseId}#${id}`);
  }

  toJSON(): TaskDecisionValuesSummary {
    return { count: this.count, decision_ids: this.decisionIds };
  }

  [INSPECT_CUSTOM](): TaskDecisionValuesSummary {
    return this.toJSON();
  }

  toString(): string {
    return `[customer decisions ${this.decisionIds.join(', ')}]`;
  }

  /** The prompt section carrying the values (empty when there are none). */
  promptLines(): string[] {
    if (this.#items.length === 0) return [];
    return [
      CONFIRMED_CUSTOMER_DECISIONS_HEADING,
      ...this.#items.map((item) => {
        const label = item.option_label ? ` (option: ${item.option_label})` : '';
        return `- [${item.decision_id}] ${item.question} (${item.item} / ${item.key}) → ${JSON.stringify(item.value)}${label}`;
      }),
      'These are the customer’s confirmed answers to the questions this task asked; build on them. Refer to a decision only by its id in summary, needs and gaps.',
      '',
    ];
  }

  /**
   * Replace echoed values (string / number forms, option labels, JSON forms)
   * with their decision id. A form of {@link TASK_DECISION_SCRUB_MIN_LENGTH}
   * characters or more is replaced wherever it appears (case-insensitive); a
   * shorter one ("yes", "A", "5%", "はい") only as a word of its own, so it
   * never rewrites part of a longer word ("yesterday", "Apple", "15%",
   * "はいけい"). A replacement is never matched again.
   */
  scrub(text: string): string {
    if (!text || this.#items.length === 0) return text;
    const long: Array<{ needle: string; id: string }> = [];
    const short: Array<{ needle: string; id: string }> = [];
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
        if (!trimmed) continue;
        (trimmed.length >= TASK_DECISION_SCRUB_MIN_LENGTH ? long : short).push({
          needle: trimmed,
          id: item.decision_id,
        });
      }
    }
    if (long.length === 0 && short.length === 0) return text;
    // Matches become private-use tokens first (no needle can match one), and
    // the ids are put in at the end.
    const ids: string[] = [];
    const token = (id: string) => {
      ids.push(id);
      return `${TOKEN_OPEN}${String.fromCharCode(TOKEN_INDEX_BASE + ids.length - 1)}${TOKEN_CLOSE}`;
    };
    let result = text;
    if (long.length > 0) {
      long.sort((a, b) => b.needle.length - a.needle.length);
      const idOf = new Map<string, string>();
      for (const { needle, id } of long) {
        if (!idOf.has(needle.toLowerCase())) idOf.set(needle.toLowerCase(), id);
      }
      const pattern = new RegExp(long.map(({ needle }) => escapeRegExp(needle)).join('|'), 'giu');
      result = result.replace(pattern, (match) => token(idOf.get(match.toLowerCase()) ?? 'id'));
    }
    if (short.length > 0) {
      short.sort((a, b) => b.needle.length - a.needle.length);
      const idOf = new Map<string, string>();
      for (const { needle, id } of short) if (!idOf.has(needle)) idOf.set(needle, id);
      const pattern = new RegExp(short.map(({ needle }) => wordPattern(needle)).join('|'), 'gu');
      result = result.replace(pattern, (match) => token(idOf.get(match) ?? 'id'));
    }
    return result.replace(TOKEN_PATTERN, (_match, index: string) => {
      const id = ids[index.charCodeAt(0) - TOKEN_INDEX_BASE] ?? 'id';
      return `[customer decision ${id}]`;
    });
  }

  /**
   * A deep copy of `value` with {@link scrub} applied to every string in it
   * (keys are kept). Objects under a key in `skipKeys` are copied unchanged.
   */
  scrubValue<T>(value: T, skipKeys: readonly string[] = []): T {
    return scrubDeep(value, (text) => this.scrub(text), new Set(skipKeys), 0) as T;
  }
}

/**
 * Scrub a worker response in place before any copy of it is stored: every
 * free-text string of the task result (the `customer_decisions` the worker
 * proposes stay as they are — they go to the confidential decision lock),
 * the notes and the parse errors.
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
    response.taskResult = values.scrubValue(response.taskResult, ['customer_decisions']);
  }
  for (const key of ['notes', 'parseErrors', 'surfaceParseErrors'] as const) {
    const list = response[key];
    if (Array.isArray(list))
      list.splice(0, list.length, ...list.map((entry) => values.scrub(String(entry))));
  }
}
