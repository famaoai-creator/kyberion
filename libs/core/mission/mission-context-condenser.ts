/**
 * Mission context condenser — bounded PoC importing the OpenHands
 * `sdk/context/condenser/` pattern (pluggable context condensation
 * strategies) into Kyberion mission context packs.
 *
 * A `ContextCondenser` takes a list of `CondensableEntry` objects and reduces
 * it into a smaller list under a byte/token budget. Everything here is
 * deterministic and pure: no I/O, no clock, no LLM. Strategies that would
 * need a model (OpenHands `LLMSummarizingCondenser`) are represented by
 * `summarize_passthrough`, which emits a deterministic marker-summary entry
 * listing the dropped refs instead of generated prose.
 */
import type { MissionContextPackSource } from './mission-context-pack-types.js';

/** Rough chars-per-token heuristic for mixed source code + prose. */
export const APPROX_BYTES_PER_TOKEN = 4;

export type ContextCondenserErrorCode = 'unknown_condenser_strategy' | 'invalid_condenser_budget';

export class ContextCondenserError extends Error {
  constructor(
    public readonly code: ContextCondenserErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ContextCondenserError';
  }
}

/**
 * One condensable unit of mission context. Adapters map pack sections
 * (sources, knowledge hints, artifact hints, evidence refs, task entries)
 * onto this shape; `T extends CondensableEntry` lets callers carry their own
 * payload fields through condensation untouched.
 */
export interface CondensableEntry {
  /** Stable reference identifying the entry (source ref, artifact id, path). */
  ref: string;
  /** Section/category label (e.g. `knowledge_hint`, `work_item`, `source`). */
  kind: string;
  /** Estimated token cost. When absent it is derived from `bytes`/JSON size. */
  tokens?: number;
  /** Estimated byte cost. When absent it is derived from `tokens`/JSON size. */
  bytes?: number;
  /** ISO-8601 timestamp; older entries are evicted first by drop strategies. */
  ts?: string;
  /**
   * Retention priority for eviction ordering — higher survives longer.
   * Defaults to 0; entries with equal priority are evicted oldest-first.
   */
  priority?: number;
  /** Caller-owned data carried through condensation untouched. */
  payload?: unknown;
}

/** Byte/token ceiling for condensation. At least one bound is required. */
export interface CondenserBudget {
  tokens?: number;
  bytes?: number;
}

interface ResolvedCondenserBudget {
  tokens: number;
  bytes: number;
}

export interface CondenserCost {
  tokens: number;
  bytes: number;
}

/** Deterministic record of what a condensation dropped, carried by the
 * synthetic summary entry emitted by `summarize_passthrough`. */
export interface CondensationSummary {
  strategy: string;
  dropped_count: number;
  dropped_refs: string[];
  dropped_kinds: string[];
  reclaimed_tokens: number;
  reclaimed_bytes: number;
}

export const CONDENSER_SUMMARY_KIND = 'condenser_summary';

/** Synthetic marker entry replacing a dropped run — never generated prose. */
export interface CondensationSummaryEntry extends CondensableEntry {
  kind: typeof CONDENSER_SUMMARY_KIND;
  summary: CondensationSummary;
}

export interface CondensationResult<T extends CondensableEntry = CondensableEntry> {
  /** Name of the condenser strategy that produced this result. */
  strategy: string;
  /** Kept entries in original order (plus any synthetic summary entry). */
  entries: Array<T | CondensationSummaryEntry>;
  /** Entries removed by condensation, in original order. */
  dropped: T[];
  /** Budget that was applied (explicit bounds only). */
  budget: CondenserBudget;
  /** Whether any entry was removed or summarized away. */
  overflow: boolean;
}

/**
 * Pluggable condensation strategy (mirrors OpenHands `CondenserBase`).
 * Implementations must be pure and must not mutate `entries`.
 */
export interface ContextCondenser {
  readonly name: string;
  condense<T extends CondensableEntry>(
    entries: readonly T[],
    budget: CondenserBudget
  ): CondensationResult<T>;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Serialized size in UTF-8 bytes — JSON.stringify().length undercounts multibyte text. */
function jsonSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

/** Chronological instant for `ts`; missing/unparseable sorts oldest (epoch -Infinity). */
function tsMs(ts: unknown): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const parsed = Date.parse(String(ts ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Estimated byte cost: explicit `bytes`, else `tokens * 4`, else JSON size. */
export function estimateEntryBytes(entry: CondensableEntry): number {
  if (finiteNonNegative(entry.bytes)) return Math.ceil(entry.bytes);
  if (finiteNonNegative(entry.tokens)) return Math.ceil(entry.tokens * APPROX_BYTES_PER_TOKEN);
  return Math.max(jsonSize(entry), new TextEncoder().encode(String(entry.ref ?? '')).length);
}

/** Estimated token cost: explicit `tokens`, else `bytes / 4` rounded up. */
export function estimateEntryTokens(entry: CondensableEntry): number {
  if (finiteNonNegative(entry.tokens)) return Math.ceil(entry.tokens);
  return Math.ceil(estimateEntryBytes(entry) / APPROX_BYTES_PER_TOKEN);
}

export function entryCost(entry: CondensableEntry): CondenserCost {
  return { tokens: estimateEntryTokens(entry), bytes: estimateEntryBytes(entry) };
}

export function totalCost(entries: readonly CondensableEntry[]): CondenserCost {
  let tokens = 0;
  let bytes = 0;
  for (const entry of entries) {
    const cost = entryCost(entry);
    tokens += cost.tokens;
    bytes += cost.bytes;
  }
  return { tokens, bytes };
}

function normalizeBudget(budget: CondenserBudget): ResolvedCondenserBudget {
  if (
    (budget?.tokens !== undefined && !finiteNonNegative(budget.tokens)) ||
    (budget?.bytes !== undefined && !finiteNonNegative(budget.bytes))
  ) {
    throw new ContextCondenserError(
      'invalid_condenser_budget',
      'An explicitly supplied budget bound must be finite and non-negative.',
      { budget }
    );
  }
  const tokens = finiteNonNegative(budget?.tokens) ? Math.ceil(budget.tokens) : Infinity;
  const bytes = finiteNonNegative(budget?.bytes) ? Math.ceil(budget.bytes) : Infinity;
  if (tokens === Infinity && bytes === Infinity) {
    throw new ContextCondenserError(
      'invalid_condenser_budget',
      'A condenser budget requires at least one finite, non-negative bound (tokens and/or bytes).',
      { budget }
    );
  }
  return { tokens, bytes };
}

function publicBudget(resolved: ResolvedCondenserBudget): CondenserBudget {
  return {
    ...(resolved.tokens !== Infinity ? { tokens: resolved.tokens } : {}),
    ...(resolved.bytes !== Infinity ? { bytes: resolved.bytes } : {}),
  };
}

/**
 * Deterministic eviction order: lowest `priority` first, then oldest `ts`
 * (missing timestamps count as oldest), then original index. Returns entry
 * indexes in the order they should be evicted.
 */
function evictionOrder(entries: readonly CondensableEntry[]): number[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const priorityDelta = (a.entry.priority ?? 0) - (b.entry.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      const tsDelta = tsMs(a.entry.ts) - tsMs(b.entry.ts);
      if (tsDelta !== 0) return tsDelta;
      return a.index - b.index;
    })
    .map(({ index }) => index);
}

function isSummaryEntry(
  entry: CondensableEntry | CondensationSummaryEntry
): entry is CondensationSummaryEntry {
  return entry.kind === CONDENSER_SUMMARY_KIND;
}

/**
 * Evict indexes in `order` until the remaining cost fits `resolved`.
 * Returns the evicted index set.
 */
function evictToBudget(
  entries: readonly CondensableEntry[],
  order: readonly number[],
  resolved: ResolvedCondenserBudget
): Set<number> {
  const evicted = new Set<number>();
  const kept = { tokens: 0, bytes: 0 };
  for (const entry of entries) {
    const cost = entryCost(entry);
    kept.tokens += cost.tokens;
    kept.bytes += cost.bytes;
  }
  const overflow = () => kept.tokens > resolved.tokens || kept.bytes > resolved.bytes;
  for (const index of order) {
    if (!overflow()) break;
    evicted.add(index);
    const cost = entryCost(entries[index]);
    kept.tokens -= cost.tokens;
    kept.bytes -= cost.bytes;
  }
  return evicted;
}

function buildSummaryEntry(
  strategy: string,
  dropped: readonly CondensableEntry[]
): CondensationSummaryEntry {
  const reclaimed = totalCost(dropped);
  const latestTs = dropped
    .map((entry) => ({ raw: String(entry.ts ?? ''), ms: tsMs(entry.ts) }))
    .sort((a, b) => a.ms - b.ms)
    .pop()?.raw;
  return {
    ref: `condenser-summary://${strategy}/${dropped.length}`,
    kind: CONDENSER_SUMMARY_KIND,
    ...(latestTs ? { ts: latestTs } : {}),
    summary: {
      strategy,
      dropped_count: dropped.length,
      dropped_refs: dropped.map((entry) => entry.ref),
      dropped_kinds: [...new Set(dropped.map((entry) => entry.kind))].sort(),
      reclaimed_tokens: reclaimed.tokens,
      reclaimed_bytes: reclaimed.bytes,
    },
  };
}

function splitByIndex<T extends CondensableEntry>(
  entries: readonly T[],
  evicted: ReadonlySet<number>
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  entries.forEach((entry, index) => {
    (evicted.has(index) ? dropped : kept).push(entry);
  });
  return { kept, dropped };
}

/**
 * `drop_oldest`: evict the lowest-priority / oldest entries until the
 * remainder fits the budget. Kept entries pass through untouched in order.
 */
export const DROP_OLDEST_CONDENSER: ContextCondenser = {
  name: 'drop_oldest',
  condense<T extends CondensableEntry>(
    entries: readonly T[],
    budget: CondenserBudget
  ): CondensationResult<T> {
    const resolved = normalizeBudget(budget);
    const evicted = evictToBudget(entries, evictionOrder(entries), resolved);
    const { kept, dropped } = splitByIndex(entries, evicted);
    return {
      strategy: DROP_OLDEST_CONDENSER.name,
      entries: kept,
      dropped,
      budget: publicBudget(resolved),
      overflow: dropped.length > 0,
    };
  },
};

/**
 * `summarize_passthrough`: evict like `drop_oldest`, then replace the dropped
 * run with one compact synthetic `condenser_summary` entry listing the
 * dropped refs and kinds. Deterministic marker summarization — no LLM. The
 * summary is inserted at the position of the earliest dropped entry and is
 * itself accounted against the budget.
 */
export const SUMMARIZE_PASSTHROUGH_CONDENSER: ContextCondenser = {
  name: 'summarize_passthrough',
  condense<T extends CondensableEntry>(
    entries: readonly T[],
    budget: CondenserBudget
  ): CondensationResult<T> {
    const resolved = normalizeBudget(budget);
    const order = evictionOrder(entries);
    const evicted = new Set<number>();
    const droppedFor = () => entries.filter((_, index) => evicted.has(index)) as T[];

    // Account for the pending summary entry while evicting: its size grows
    // with the dropped set, so re-evaluate on every eviction.
    let cursor = 0;
    while (cursor < order.length) {
      const dropped = droppedFor();
      const summaryCost =
        dropped.length > 0
          ? entryCost(buildSummaryEntry(SUMMARIZE_PASSTHROUGH_CONDENSER.name, dropped))
          : { tokens: 0, bytes: 0 };
      const keptCost = totalCost(entries.filter((_, index) => !evicted.has(index)));
      if (
        keptCost.tokens + summaryCost.tokens <= resolved.tokens &&
        keptCost.bytes + summaryCost.bytes <= resolved.bytes
      ) {
        break;
      }
      evicted.add(order[cursor]);
      cursor += 1;
    }

    const { kept, dropped } = splitByIndex(entries, evicted);
    if (dropped.length === 0) {
      return {
        strategy: SUMMARIZE_PASSTHROUGH_CONDENSER.name,
        entries: kept,
        dropped,
        budget: publicBudget(resolved),
        overflow: false,
      };
    }

    const summary = buildSummaryEntry(SUMMARIZE_PASSTHROUGH_CONDENSER.name, dropped);
    const summaryCost = entryCost(summary);
    const keptCost = totalCost(kept);
    const summaryFits =
      keptCost.tokens + summaryCost.tokens <= resolved.tokens &&
      keptCost.bytes + summaryCost.bytes <= resolved.bytes;

    if (!summaryFits) {
      // Degenerate budget: the marker alone cannot fit. Return kept entries
      // only — the dropped list still records what was removed.
      return {
        strategy: SUMMARIZE_PASSTHROUGH_CONDENSER.name,
        entries: kept,
        dropped,
        budget: publicBudget(resolved),
        overflow: true,
      };
    }

    // Insert the summary where the earliest dropped entry sat.
    const firstDroppedIndex = Math.min(...evicted);
    const insertAt = entries
      .slice(0, firstDroppedIndex)
      .filter((_, index) => !evicted.has(index)).length;
    const result: Array<T | CondensationSummaryEntry> = [
      ...kept.slice(0, insertAt),
      summary,
      ...kept.slice(insertAt),
    ];
    return {
      strategy: SUMMARIZE_PASSTHROUGH_CONDENSER.name,
      entries: result,
      dropped,
      budget: publicBudget(resolved),
      overflow: true,
    };
  },
};

/**
 * `dedupe_refs`: collapse duplicate refs keeping the newest entry per ref
 * (max `ts`; ties keep the last occurrence), then enforce the budget with
 * the same lowest-priority/oldest eviction as `drop_oldest`. Duplicate
 * copies removed by the collapse are reported in `dropped`.
 */
export const DEDUPE_REFS_CONDENSER: ContextCondenser = {
  name: 'dedupe_refs',
  condense<T extends CondensableEntry>(
    entries: readonly T[],
    budget: CondenserBudget
  ): CondensationResult<T> {
    const resolved = normalizeBudget(budget);
    const winnerByRef = new Map<string, number>();
    entries.forEach((entry, index) => {
      const winnerIndex = winnerByRef.get(entry.ref);
      if (winnerIndex === undefined) {
        winnerByRef.set(entry.ref, index);
        return;
      }
      const winner = entries[winnerIndex];
      // Newer ts wins; equal ts keeps the later occurrence (newest copy).
      if (tsMs(entry.ts) >= tsMs(winner.ts)) {
        winnerByRef.set(entry.ref, index);
      }
    });
    const dedupedRemoved = new Set<number>(
      entries
        .map((_, index) => index)
        .filter((index) => winnerByRef.get(entries[index].ref) !== index)
    );
    const deduped = entries.filter((_, index) => !dedupedRemoved.has(index));
    const dedupedOriginalIndex = entries
      .map((_, index) => index)
      .filter((index) => !dedupedRemoved.has(index));

    const evictedInDeduped = evictToBudget(deduped, evictionOrder(deduped), resolved);
    const evicted = new Set<number>(dedupedRemoved);
    evictedInDeduped.forEach((position) => evicted.add(dedupedOriginalIndex[position]));

    const { kept, dropped } = splitByIndex(entries, evicted);
    return {
      strategy: DEDUPE_REFS_CONDENSER.name,
      entries: kept,
      dropped,
      budget: publicBudget(resolved),
      overflow: dropped.length > 0,
    };
  },
};

/** Built-in strategy registry, mirroring the OpenHands condenser catalog. */
export const CONTEXT_CONDENSERS: Readonly<Record<string, ContextCondenser>> = Object.freeze({
  [DROP_OLDEST_CONDENSER.name]: DROP_OLDEST_CONDENSER,
  [SUMMARIZE_PASSTHROUGH_CONDENSER.name]: SUMMARIZE_PASSTHROUGH_CONDENSER,
  [DEDUPE_REFS_CONDENSER.name]: DEDUPE_REFS_CONDENSER,
});

export function listContextCondenserNames(): string[] {
  return Object.keys(CONTEXT_CONDENSERS).sort();
}

export function isContextCondenserName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTEXT_CONDENSERS, name);
}

/** Resolve a condenser by name; unknown names throw a stable coded error. */
export function getContextCondenser(name: string): ContextCondenser {
  const key = String(name ?? '').trim();
  const condenser = isContextCondenserName(key) ? CONTEXT_CONDENSERS[key] : undefined;
  if (!condenser) {
    throw new ContextCondenserError(
      'unknown_condenser_strategy',
      `Unknown context condenser strategy: ${key || '(empty)'}`,
      { strategy: key, available: listContextCondenserNames() }
    );
  }
  return condenser;
}

/**
 * Apply a condenser strategy to a pack-like entry list under a byte/token
 * budget. `strategy` is a registered name or a custom `ContextCondenser`.
 * Input entries are never mutated.
 */
export function condenseContextPack<T extends CondensableEntry>(
  entries: readonly T[],
  budget: CondenserBudget,
  strategy: string | ContextCondenser = DROP_OLDEST_CONDENSER.name
): CondensationResult<T> {
  const condenser = typeof strategy === 'string' ? getContextCondenser(strategy) : strategy;
  if (!condenser || typeof condenser.condense !== 'function' || !condenser.name) {
    throw new ContextCondenserError(
      'unknown_condenser_strategy',
      'A context condenser must expose `name` and `condense(entries, budget)`.',
      { strategy }
    );
  }
  return condenser.condense(entries, budget);
}

/** Priority ladder for `entriesFromMissionContextPackSources`. */
const SOURCE_KIND_PRIORITY: Readonly<Record<MissionContextPackSource['kind'], number>> = {
  mission_state: 100,
  mission_team: 90,
  work_item: 80,
  task_session: 70,
  project_state: 60,
  project_track: 50,
  knowledge_hint: 40,
  skill_resource: 30,
  other: 10,
};

/**
 * Map a pack's `sources` list onto condensable entries — the bridge between
 * `MissionContextPack` sections and the condenser interface. Byte cost is the
 * serialized source size; `captured_at` becomes the recency timestamp and
 * `kind` drives the retention priority ladder above.
 */
export function entriesFromMissionContextPackSources(
  sources: readonly MissionContextPackSource[]
): CondensableEntry[] {
  return (sources || []).map((source) => ({
    ref: source.ref,
    kind: source.kind,
    bytes: jsonSize(source),
    ...(source.captured_at ? { ts: source.captured_at } : {}),
    priority: SOURCE_KIND_PRIORITY[source.kind] ?? 0,
    payload: source,
  }));
}

/** Result of condensing a pack's `sources` list through the adapter. */
export interface CondensedMissionContextPackSources {
  /**
   * Replacement `MissionContextPackSource[]`: kept sources round-trip
   * untouched via `payload`; a `summarize_passthrough` marker becomes a
   * schema-valid `other` source carrying the dropped-entry accounting on
   * `condensation`.
   */
  sources: MissionContextPackSource[];
  /** Raw condensation result (dropped entries, budget, overflow flag). */
  result: CondensationResult;
}

/**
 * Opt-in bridge between `MissionContextPack.sources` and the condenser
 * interface: map → condense → re-materialize. Under budget the sources pass
 * through in order; input sources are never mutated.
 */
function summaryMarkerSource(entry: CondensationSummaryEntry): MissionContextPackSource {
  return {
    kind: 'other',
    ref: entry.ref,
    ...(entry.ts ? { captured_at: entry.ts } : {}),
    summary: `Condensed ${entry.summary.dropped_count} context source(s) via ${entry.summary.strategy}.`,
    condensation: entry.summary,
  };
}

export function condenseMissionContextPackSources(
  sources: readonly MissionContextPackSource[],
  options: { budget: CondenserBudget; strategy?: string | ContextCondenser }
): CondensedMissionContextPackSources {
  const result = condenseContextPack(
    entriesFromMissionContextPackSources(sources),
    options.budget,
    options.strategy ?? DROP_OLDEST_CONDENSER.name
  );
  const remapped = result.entries.flatMap((entry): MissionContextPackSource[] => {
    if (isSummaryEntry(entry)) {
      const marker = summaryMarkerSource(entry);
      // The emitted marker must not exceed the cost the condenser budgeted
      // for it — the source representation grows beyond the internal entry
      // (summary text + condensation metadata), so shrink deterministically
      // until it fits: drop the dropped-refs list, then kinds, then the
      // condensation block, and finally the marker itself.
      const accounted = entryCost(entry);
      const fits = (source: MissionContextPackSource): boolean => {
        const emittedBytes = jsonSize(source);
        const emittedTokens = Math.ceil(emittedBytes / APPROX_BYTES_PER_TOKEN);
        return (
          (accounted.bytes === undefined || emittedBytes <= accounted.bytes) &&
          (accounted.tokens === undefined || emittedTokens <= accounted.tokens)
        );
      };
      if (fits(marker)) return [marker];
      const withoutRefs = {
        ...marker,
        condensation: { ...marker.condensation!, dropped_refs: [] },
      };
      if (fits(withoutRefs)) return [withoutRefs];
      const minimal = {
        kind: 'other' as const,
        ref: marker.ref,
        summary: `Condensed ${marker.condensation!.dropped_count} context source(s).`,
        condensation: {
          ...marker.condensation!,
          dropped_refs: [],
          dropped_kinds: [],
        },
      };
      if (fits(minimal)) return [minimal];
      return [];
    }
    return [entry.payload as MissionContextPackSource];
  });
  return { sources: remapped, result };
}

export { isSummaryEntry as isCondenserSummaryEntry };
