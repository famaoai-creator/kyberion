import { describe, expect, it } from 'vitest';

import {
  condenseContextPack,
  condenseMissionContextPackSources,
  CONTEXT_CONDENSERS,
  CONDENSER_SUMMARY_KIND,
  ContextCondenserError,
  DEDUPE_REFS_CONDENSER,
  DROP_OLDEST_CONDENSER,
  entriesFromMissionContextPackSources,
  entryCost,
  estimateEntryBytes,
  estimateEntryTokens,
  getContextCondenser,
  isCondenserSummaryEntry,
  listContextCondenserNames,
  SUMMARIZE_PASSTHROUGH_CONDENSER,
  totalCost,
  type CondensableEntry,
  type CondensationSummaryEntry,
  type ContextCondenser,
} from './mission-context-condenser.js';
import type { MissionContextPackSource } from './mission-context-pack-types.js';

function entry(partial: Partial<CondensableEntry> & { ref: string }): CondensableEntry {
  return { kind: 'other', ...partial };
}

describe('context condenser registry', () => {
  it('exposes the built-in strategies', () => {
    expect(listContextCondenserNames()).toEqual([
      'dedupe_refs',
      'drop_oldest',
      'summarize_passthrough',
    ]);
    expect(CONTEXT_CONDENSERS.drop_oldest).toBe(DROP_OLDEST_CONDENSER);
    expect(CONTEXT_CONDENSERS.summarize_passthrough).toBe(SUMMARIZE_PASSTHROUGH_CONDENSER);
    expect(CONTEXT_CONDENSERS.dedupe_refs).toBe(DEDUPE_REFS_CONDENSER);
    expect(getContextCondenser('drop_oldest')).toBe(DROP_OLDEST_CONDENSER);
  });

  it('rejects an unknown strategy with a stable code', () => {
    const act = () => getContextCondenser('llm_magic');
    expect(act).toThrowError(ContextCondenserError);
    try {
      getContextCondenser('llm_magic');
      expect.unreachable('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextCondenserError);
      expect((error as ContextCondenserError).code).toBe('unknown_condenser_strategy');
      expect((error as ContextCondenserError).details.available).toEqual(
        listContextCondenserNames()
      );
    }
    expect(() => condenseContextPack([], { bytes: 10 }, 'nope')).toThrowError(
      ContextCondenserError
    );
    try {
      condenseContextPack([], { bytes: 10 }, 'nope');
      expect.unreachable('expected throw');
    } catch (error) {
      expect((error as ContextCondenserError).code).toBe('unknown_condenser_strategy');
    }
  });

  it('rejects an invalid budget with a stable code', () => {
    for (const budget of [{}, { tokens: -1 }, { bytes: Number.NaN }, { tokens: Infinity }]) {
      try {
        condenseContextPack([], budget, 'drop_oldest');
        expect.unreachable('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ContextCondenserError);
        expect((error as ContextCondenserError).code).toBe('invalid_condenser_budget');
      }
    }
  });

  it('accepts a custom condenser instance', () => {
    const custom: ContextCondenser = {
      name: 'keep_none',
      condense: (entries, budget) => ({
        strategy: 'keep_none',
        entries: [],
        dropped: [...entries],
        budget,
        overflow: entries.length > 0,
      }),
    };
    const result = condenseContextPack([entry({ ref: 'a', bytes: 1 })], { bytes: 10 }, custom);
    expect(result.strategy).toBe('keep_none');
    expect(result.entries).toEqual([]);
    expect(result.dropped.map((e) => e.ref)).toEqual(['a']);
  });
});

describe('cost estimation', () => {
  it('prefers explicit measures and derives the missing dimension', () => {
    expect(estimateEntryBytes(entry({ ref: 'a', bytes: 100, tokens: 5 }))).toBe(100);
    expect(estimateEntryTokens(entry({ ref: 'a', bytes: 100, tokens: 5 }))).toBe(5);
    expect(estimateEntryBytes(entry({ ref: 'a', tokens: 10 }))).toBe(40);
    expect(estimateEntryTokens(entry({ ref: 'a', bytes: 100 }))).toBe(25);
  });

  it('falls back to serialized size and stays deterministic', () => {
    const e = entry({ ref: 'a', kind: 'knowledge_hint' });
    expect(estimateEntryBytes(e)).toBeGreaterThan(0);
    expect(estimateEntryBytes(e)).toBe(estimateEntryBytes({ ...e }));
  });

  it('sums costs for a list', () => {
    const entries = [entry({ ref: 'a', bytes: 10 }), entry({ ref: 'b', bytes: 20 })];
    expect(totalCost(entries)).toEqual({ tokens: 8, bytes: 30 });
  });
});

describe('drop_oldest', () => {
  it('passes entries through untouched when under budget', () => {
    const entries = [entry({ ref: 'a', bytes: 10 }), entry({ ref: 'b', bytes: 10 })];
    const result = condenseContextPack(entries, { bytes: 100 }, 'drop_oldest');
    expect(result.strategy).toBe('drop_oldest');
    expect(result.overflow).toBe(false);
    expect(result.dropped).toEqual([]);
    expect(result.entries.map((e) => e.ref)).toEqual(['a', 'b']);
  });

  it('evicts oldest entries first until the byte budget is met', () => {
    const entries = [
      entry({ ref: 'old', bytes: 60, ts: '2026-01-01T00:00:00Z' }),
      entry({ ref: 'mid', bytes: 60, ts: '2026-02-01T00:00:00Z' }),
      entry({ ref: 'new', bytes: 60, ts: '2026-03-01T00:00:00Z' }),
    ];
    const result = condenseContextPack(entries, { bytes: 120 }, 'drop_oldest');
    expect(result.overflow).toBe(true);
    expect(result.dropped.map((e) => e.ref)).toEqual(['old']);
    expect(result.entries.map((e) => e.ref)).toEqual(['mid', 'new']);
    expect(totalCost(result.entries).bytes).toBeLessThanOrEqual(120);
  });

  it('evicts the lowest priority first and preserves kept order', () => {
    const entries = [
      entry({ ref: 'keep-new', bytes: 50, priority: 90, ts: '2026-03-01T00:00:00Z' }),
      entry({ ref: 'drop-first', bytes: 50, priority: 1, ts: '2026-03-05T00:00:00Z' }),
      entry({ ref: 'keep-old', bytes: 50, priority: 90, ts: '2026-01-01T00:00:00Z' }),
    ];
    const result = condenseContextPack(entries, { bytes: 100 }, 'drop_oldest');
    expect(result.dropped.map((e) => e.ref)).toEqual(['drop-first']);
    expect(result.entries.map((e) => e.ref)).toEqual(['keep-new', 'keep-old']);
  });

  it('respects a token budget', () => {
    const entries = [
      entry({ ref: 'a', tokens: 40, ts: '2026-01-01T00:00:00Z' }),
      entry({ ref: 'b', tokens: 40, ts: '2026-02-01T00:00:00Z' }),
      entry({ ref: 'c', tokens: 40, ts: '2026-03-01T00:00:00Z' }),
    ];
    const result = condenseContextPack(entries, { tokens: 80 }, 'drop_oldest');
    expect(result.entries.map((e) => e.ref)).toEqual(['b', 'c']);
    expect(totalCost(result.entries).tokens).toBeLessThanOrEqual(80);
  });

  it('is deterministic across repeated runs and never mutates input', () => {
    const entries = [
      entry({ ref: 'a', bytes: 30, ts: '2026-01-01T00:00:00Z' }),
      entry({ ref: 'b', bytes: 30, ts: '2026-02-01T00:00:00Z' }),
      entry({ ref: 'c', bytes: 30, ts: '2026-03-01T00:00:00Z' }),
    ];
    const snapshot = JSON.stringify(entries);
    const first = condenseContextPack(entries, { bytes: 60 }, 'drop_oldest');
    const second = condenseContextPack(entries, { bytes: 60 }, 'drop_oldest');
    expect(first).toEqual(second);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});

describe('summarize_passthrough', () => {
  const entries = [
    entry({ ref: 'old-hint', kind: 'knowledge_hint', bytes: 300, ts: '2026-01-01T00:00:00Z' }),
    entry({ ref: 'mid-src', kind: 'other', bytes: 300, ts: '2026-02-01T00:00:00Z' }),
    entry({ ref: 'new-item', kind: 'work_item', bytes: 300, ts: '2026-03-01T00:00:00Z' }),
  ];

  function condense(bytes: number) {
    return condenseContextPack(entries, { bytes }, 'summarize_passthrough');
  }

  it('emits exactly one condenser_summary entry that lists dropped refs and kinds', () => {
    const result = condense(800);
    expect(result.overflow).toBe(true);
    const summaries = result.entries.filter(isCondenserSummaryEntry);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0] as CondensationSummaryEntry;
    expect(summary.kind).toBe(CONDENSER_SUMMARY_KIND);
    expect(summary.summary.strategy).toBe('summarize_passthrough');
    expect(summary.summary.dropped_count).toBe(result.dropped.length);
    expect(summary.summary.dropped_refs).toEqual(result.dropped.map((e) => e.ref));
    expect(summary.summary.dropped_refs).toContain('old-hint');
    expect(summary.summary.dropped_refs).toContain('mid-src');
    expect(summary.summary.dropped_kinds).toEqual(
      [...new Set(result.dropped.map((e) => e.kind))].sort()
    );
    // Kept entries are the originals, not rewritten.
    const kept = result.entries.filter((e) => !isCondenserSummaryEntry(e));
    expect(kept.map((e) => e.ref)).toEqual(['new-item']);
    expect(totalCost(result.entries).bytes).toBeLessThanOrEqual(800);
  });

  it('keeps everything verbatim when the whole list already fits', () => {
    const result = condense(1000);
    expect(result.overflow).toBe(false);
    expect(result.entries.map((e) => e.ref)).toEqual(['old-hint', 'mid-src', 'new-item']);
    expect(result.entries.every((e) => !isCondenserSummaryEntry(e))).toBe(true);
    expect(result.dropped).toEqual([]);
  });

  it('is deterministic and accounts the summary against the budget', () => {
    const first = condense(400);
    const second = condense(400);
    expect(first).toEqual(second);
    expect(totalCost(first.entries).bytes).toBeLessThanOrEqual(400);
  });
});

describe('dedupe_refs', () => {
  it('collapses duplicate refs keeping the newest timestamp', () => {
    const entries = [
      entry({ ref: 'dup', bytes: 10, ts: '2026-01-01T00:00:00Z', payload: 'stale' }),
      entry({ ref: 'solo', bytes: 10, ts: '2026-01-02T00:00:00Z' }),
      entry({ ref: 'dup', bytes: 10, ts: '2026-03-01T00:00:00Z', payload: 'fresh' }),
    ];
    const result = condenseContextPack(entries, { bytes: 1000 }, 'dedupe_refs');
    expect(result.entries.map((e) => e.ref)).toEqual(['solo', 'dup']);
    const kept = result.entries.find((e) => e.ref === 'dup') as CondensableEntry;
    expect(kept.ts).toBe('2026-03-01T00:00:00Z');
    expect(kept.payload).toBe('fresh');
    expect(result.dropped.map((e) => `${e.ref}@${e.ts}`)).toEqual(['dup@2026-01-01T00:00:00Z']);
  });

  it('still enforces the budget after dedupe, evicting lowest priority first', () => {
    const entries = [
      entry({ ref: 'a', bytes: 60, priority: 10, ts: '2026-01-01T00:00:00Z' }),
      entry({ ref: 'b', bytes: 60, priority: 90, ts: '2026-02-01T00:00:00Z' }),
      entry({ ref: 'b', bytes: 60, priority: 90, ts: '2026-01-15T00:00:00Z' }),
    ];
    const result = condenseContextPack(entries, { bytes: 60 }, 'dedupe_refs');
    expect(result.entries.map((e) => `${e.ref}@${e.ts}`)).toEqual(['b@2026-02-01T00:00:00Z']);
    expect(result.dropped).toHaveLength(2);
    expect(totalCost(result.entries).bytes).toBeLessThanOrEqual(60);
  });
});

describe('entriesFromMissionContextPackSources', () => {
  it('maps pack sources onto condensable entries with kind priorities', () => {
    const sources: MissionContextPackSource[] = [
      { kind: 'mission_state', ref: 'mission:M1', captured_at: '2026-01-01T00:00:00Z' },
      { kind: 'knowledge_hint', ref: 'knowledge/x.md', captured_at: '2026-02-01T00:00:00Z' },
      { kind: 'other', ref: 'evidence:1' },
    ];
    const entries = entriesFromMissionContextPackSources(sources);
    expect(entries.map((e) => e.ref)).toEqual(['mission:M1', 'knowledge/x.md', 'evidence:1']);
    expect(entries[0].priority).toBeGreaterThan(entries[1].priority ?? 0);
    expect(entries[0].ts).toBe('2026-01-01T00:00:00Z');
    expect(entries.every((e) => (e.bytes ?? 0) > 0)).toBe(true);
    // And the adapter feeds straight into the condenser.
    const result = condenseContextPack(entries, { bytes: entries[0].bytes! + 1 }, 'drop_oldest');
    expect(result.entries[0].ref).toBe('mission:M1');
  });

  it('accepts an empty source list', () => {
    expect(entriesFromMissionContextPackSources([])).toEqual([]);
    expect(condenseContextPack([], { bytes: 10 }, 'drop_oldest').entries).toEqual([]);
  });
});

describe('review fixes', () => {
  it('rejects an explicitly invalid bound even when the other is valid', () => {
    try {
      condenseContextPack([{ ref: 'a', kind: 'k' }], { tokens: -1, bytes: 1000 });
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('invalid_condenser_budget');
    }
  });

  it('rejects prototype-property names in the registry lookup', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      try {
        getContextCondenser(name);
        expect.unreachable();
      } catch (e) {
        expect((e as { code: string }).code).toBe('unknown_condenser_strategy');
      }
    }
  });

  it('counts serialized UTF-8 bytes, not UTF-16 units', () => {
    const jp = { ref: 'r', kind: 'k', payload: '日本語' };
    expect(estimateEntryBytes(jp)).toBeGreaterThan(JSON.stringify(jp).length);
  });

  it('orders timestamps chronologically across offsets (dedupe keeps true newest)', () => {
    const older = { ref: 'r', kind: 'k', ts: '2026-01-01T01:00:00+02:00' };
    const newer = { ref: 'r', kind: 'k', ts: '2026-01-01T00:00:00Z' };
    const result = condenseContextPack([older, newer], { bytes: 10_000 }, 'dedupe_refs');
    expect(result.entries[0].ts).toBe('2026-01-01T00:00:00Z');
  });
});

describe('condenseMissionContextPackSources adapter', () => {
  const packSources = (): MissionContextPackSource[] => [
    {
      kind: 'mission_state',
      ref: 'mission:MSN-CONDENSER-1',
      summary: 'Mission state for MSN-CONDENSER-1',
      captured_at: '2026-06-05T00:00:00.000Z',
    },
    {
      kind: 'work_item',
      ref: 'work-item:WIT-CONDENSER-1',
      summary: 'Work item WIT-CONDENSER-1',
      captured_at: '2026-06-05T00:00:00.000Z',
    },
    {
      kind: 'knowledge_hint',
      ref: 'knowledge/product/a.md',
      // Padded so a single hint costs more than the summary-marker slack.
      summary: `Hint A ${'a'.repeat(400)}`,
      captured_at: '2026-06-05T00:00:00.000Z',
    },
    {
      kind: 'knowledge_hint',
      ref: 'knowledge/product/b.md',
      summary: `Hint B ${'b'.repeat(400)}`,
      captured_at: '2026-06-05T00:00:00.000Z',
    },
  ];

  it('passes sources through untouched under budget', () => {
    const input = packSources();
    const { sources: output, result } = condenseMissionContextPackSources(input, {
      budget: { bytes: 1_000_000 },
    });
    expect(result.overflow).toBe(false);
    expect(result.dropped).toEqual([]);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.every((source, index) => source === input[index])).toBe(true);
  });

  it('evicts lowest-priority sources and re-materializes the summary marker', () => {
    const input = packSources();
    const entries = entriesFromMissionContextPackSources(input);
    // Fits mission_state + work_item + the summary marker, never a padded hint.
    const budget = entryCost(entries[0]).bytes + entryCost(entries[1]).bytes + 800;
    const { sources: output, result } = condenseMissionContextPackSources(input, {
      budget: { bytes: budget },
      strategy: 'summarize_passthrough',
    });

    expect(result.overflow).toBe(true);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(output.length).toBeLessThan(input.length);

    const marker = output.find((source) => source.ref.startsWith('condenser-summary://'));
    expect(marker?.kind).toBe('other');
    expect(marker?.condensation?.strategy).toBe('summarize_passthrough');
    expect(marker?.condensation?.dropped_count).toBe(result.dropped.length);
    // dropped_refs may be shrunk to [] when the emitted marker would exceed
    // its accounted entry cost; when present it must match the dropped set.
    if (marker?.condensation?.dropped_refs?.length) {
      expect(marker.condensation.dropped_refs).toEqual(
        result.dropped.map((dropped) => dropped.ref)
      );
    }

    // The mission-state source sits at the top of the priority ladder.
    expect(output.some((source) => source.ref === 'mission:MSN-CONDENSER-1')).toBe(true);
    // Input sources are never mutated.
    expect(input).toHaveLength(4);
    expect(input.every((source) => source.condensation === undefined)).toBe(true);
  });

  it('defaults to drop_oldest with no synthetic marker', () => {
    const input = packSources();
    const { sources: output, result } = condenseMissionContextPackSources(input, {
      budget: { bytes: 10 },
    });
    expect(result.strategy).toBe('drop_oldest');
    expect(result.dropped).toHaveLength(input.length);
    expect(output).toEqual([]);
  });

  it('shrinks the emitted marker to its accounted cost — never exceeding the budget', () => {
    // One oversized source is dropped; the budget barely fits the internal
    // summary entry, so the emitted marker source would exceed it unless
    // the adapter shrinks the final representation (or drops the marker).
    const bigSource: MissionContextPackSource = {
      kind: 'other',
      ref: 'knowledge/product/big.md',
      summary: 'x'.repeat(500),
      payload: { body: 'y'.repeat(500) },
    };
    const budget = 238;
    const { sources: output, result } = condenseMissionContextPackSources([bigSource], {
      budget: { bytes: budget },
      strategy: 'summarize_passthrough',
    });
    const markerEntry = result.entries.find(isCondenserSummaryEntry);
    const emitted = output.find((s) => s.ref.startsWith('condenser-summary://'));
    if (markerEntry) {
      // Marker survived: emitted representation must fit the accounted cost.
      const accounted = entryCost(markerEntry).bytes;
      expect(emitted).toBeDefined();
      expect(new TextEncoder().encode(JSON.stringify(emitted)).length).toBeLessThanOrEqual(
        accounted
      );
    } else {
      // Marker dropped entirely — also a valid bounded outcome.
      expect(emitted).toBeUndefined();
    }
    expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThanOrEqual(budget);
  });
});
