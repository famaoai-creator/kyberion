import type { ConciergeSummary } from './summary-event';
import type {
  ConciergeHygieneInquiry,
  ConciergeMemoryQueueItem,
} from './concierge-advisory-response';
import type { FrontDeskMessageKey } from './i18n';

/**
 * FD-04 (決める): pure helpers behind the single decision queue on `/`.
 * `page.tsx` builds the urgency-ordered list of entries (unchanged from the
 * CS-04 queue), then hands it here for (a) the deferred/"あとで見る" split
 * and (b) per-card field mapping. No I/O, no `t()` — the component owns
 * translation and rendering.
 */

export type DecideApprovalItem = ConciergeSummary['approval_queue'][number];
export type DecideHygieneItem = ConciergeHygieneInquiry;
export type DecideMemoryItem = ConciergeMemoryQueueItem;
export type DecideOutcomeItem = ConciergeSummary['outcome_feed'][number];
export type DecideExceptionItem = ConciergeSummary['exception_feed'][number];

export type DecideKind = 'approval' | 'hygiene' | 'memory' | 'outcome' | 'exception';

export type DecideQueueEntry =
  | { id: string; kind: 'approval'; item: DecideApprovalItem }
  | { id: string; kind: 'hygiene'; item: DecideHygieneItem }
  | { id: string; kind: 'memory'; item: DecideMemoryItem }
  | { id: string; kind: 'outcome'; item: DecideOutcomeItem }
  | { id: string; kind: 'exception'; item: DecideExceptionItem };

export interface DecideCardFields {
  /** decide_why body text, when the item carries one. */
  why?: string;
  /** kind-specific second-column body text, when the item carries one. */
  effect?: string;
  /** vocabulary key for the second column's heading; omitted entirely (no column) when unset. */
  effectLabelKey?: FrontDeskMessageKey;
  /** decide_evidence link target, when the item exposes one. */
  evidenceHref?: string;
  /** tenant slug the item belongs to, when the item carries one. */
  tenantSlug?: string;
}

/**
 * Maps a queue entry to the plain-language fields the FD-04 card renders.
 *
 * None of the item types the concierge client currently receives
 * (`ConciergeSummary['approval_queue'|'outcome_feed'|'exception_feed']`,
 * `ConciergeHygieneInquiry`, `ConciergeMemoryQueueItem` — see
 * `summary-event.ts` / `concierge-advisory-response.ts`) carry a tenant
 * slug or a distinct "expected consequence" field separate from their one
 * explanatory string, so `tenantSlug` is always absent today and `effect`
 * is always empty (only `effectLabelKey` is set, so the column header never
 * renders without a field to put under it — see `hasEffectColumn`). The
 * mapping is written per-kind so a future field only needs a value here.
 *
 * `hygiene`'s `why` is the raw reason code (`design_missing` / …) — the
 * component translates it via the existing `hygiene.reason.<code>`
 * (concierge domain) key, matching the pre-FD-04 hygiene card.
 */
export function deriveCardFields(entry: DecideQueueEntry): DecideCardFields {
  switch (entry.kind) {
    case 'approval':
      return {
        // A reason that merely repeats the title says nothing — leave the
        // column out rather than showing the same words twice.
        why:
          entry.item.reason && entry.item.reason.trim() !== entry.item.title.trim()
            ? entry.item.reason
            : undefined,
        effectLabelKey: 'decide_effect_approval',
      };
    case 'hygiene':
      return {
        why: entry.item.reason || undefined,
        effectLabelKey: 'decide_options',
      };
    case 'memory':
      return {
        why: entry.item.summary || undefined,
      };
    case 'outcome':
      return {
        why: entry.item.summary || undefined,
      };
    case 'exception':
      return {
        why: entry.item.text || undefined,
        effectLabelKey: 'decide_effect_action',
      };
    default:
      return {};
  }
}

/** True only when there is both a heading and a body for the second column. */
export function hasEffectColumn(fields: DecideCardFields): boolean {
  return Boolean(fields.effectLabelKey && fields.effect);
}

export interface GroupedDecideQueue {
  /** Entries still in the live queue, in the same (urgency) order as the input. */
  queue: DecideQueueEntry[];
  /** Entries the viewer set aside with `decide_later`, in the same order as the input. */
  deferred: DecideQueueEntry[];
  /** Per-kind counts within `queue` (used by the filter chips). */
  countsByKind: Record<DecideKind, number>;
}

const DECIDE_KINDS: readonly DecideKind[] = [
  'approval',
  'hygiene',
  'memory',
  'outcome',
  'exception',
];

function emptyCounts(): Record<DecideKind, number> {
  return { approval: 0, hygiene: 0, memory: 0, outcome: 0, exception: 0 };
}

/**
 * Splits the urgency-ordered queue into the visible queue and the
 * client-side "あとで見る項目" (`decide_later`) section, and counts how many
 * of each kind remain visible (for the `decide_filter_*` chips). Moving an
 * item to `deferred` never removes it — a reload restores it here (still
 * collapsed), never back into the live queue and never dropped.
 */
export function groupDecideQueue(
  items: readonly DecideQueueEntry[],
  deferredIds: ReadonlySet<string> | readonly string[]
): GroupedDecideQueue {
  const deferredSet = deferredIds instanceof Set ? deferredIds : new Set(deferredIds);
  const queue: DecideQueueEntry[] = [];
  const deferred: DecideQueueEntry[] = [];
  const countsByKind = emptyCounts();
  for (const entry of items) {
    if (deferredSet.has(entry.id)) {
      deferred.push(entry);
    } else {
      queue.push(entry);
      countsByKind[entry.kind] += 1;
    }
  }
  return { queue, deferred, countsByKind };
}

/** Kinds present in `countsByKind` with a non-zero count, in the fixed FD-04 order. */
export function presentKinds(countsByKind: Record<DecideKind, number>): DecideKind[] {
  return DECIDE_KINDS.filter((kind) => countsByKind[kind] > 0);
}
