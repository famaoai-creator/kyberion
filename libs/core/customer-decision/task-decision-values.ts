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

/** Shorter string forms are not scrubbed (they would rewrite ordinary words and numbers). */
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

  /** Replace echoed values (string / number forms, option labels) with their decision id. */
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
        if (trimmed.length >= TASK_DECISION_SCRUB_MIN_LENGTH) {
          needles.push({ needle: trimmed, id: item.decision_id });
        }
      }
    }
    if (needles.length === 0) return text;
    // One pass, longest first: a replacement is never matched again.
    needles.sort((a, b) => b.needle.length - a.needle.length);
    const idOf = new Map<string, string>();
    for (const { needle, id } of needles) {
      if (!idOf.has(needle.toLowerCase())) idOf.set(needle.toLowerCase(), id);
    }
    const pattern = new RegExp(needles.map(({ needle }) => escapeRegExp(needle)).join('|'), 'giu');
    return text.replace(
      pattern,
      (match) => `[customer decision ${idOf.get(match.toLowerCase()) ?? 'id'}]`
    );
  }
}
