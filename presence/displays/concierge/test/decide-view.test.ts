import { describe, expect, it } from 'vitest';
import {
  deriveCardFields,
  groupDecideQueue,
  hasEffectColumn,
  presentKinds,
  type DecideQueueEntry,
} from '../src/lib/decide-view';

function approval(id: string, overrides: Partial<{ reason: string }> = {}): DecideQueueEntry {
  return {
    id,
    kind: 'approval',
    item: {
      id,
      channel: 'email',
      storage_channel: 'inbox',
      title: 'Send the proposal',
      reason: 'Contains a client commitment',
      requested_at: '2026-09-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

function hygiene(id: string, overrides: Partial<{ reason: string }> = {}): DecideQueueEntry {
  return {
    id,
    kind: 'hygiene',
    item: {
      mission_id: id,
      title: 'Quarterly report',
      reason: 'design_missing',
      age_days: 3,
      ...overrides,
    } as never,
  };
}

function memory(id: string, overrides: Partial<{ summary: string }> = {}): DecideQueueEntry {
  return {
    id,
    kind: 'memory',
    item: {
      id,
      kind: 'heuristic',
      summary: 'Always confirm budget before booking travel',
      source: 'mission-42',
      source_type: 'mission',
      sensitivity_tier: 'confidential',
      occurrences: 2,
      queued_at: '2026-09-01T00:00:00.000Z',
      ...overrides,
    } as never,
  };
}

function outcome(id: string, overrides: Partial<{ summary: string }> = {}): DecideQueueEntry {
  return {
    id,
    kind: 'outcome',
    item: {
      entry_id: id,
      title: 'Board deck',
      summary: 'Draft ready for review',
      artifact_paths: [],
      status: 'unread',
      updated_at: '2026-09-01T00:00:00.000Z',
      ...overrides,
    } as never,
  };
}

function exception(id: string, overrides: Partial<{ text: string }> = {}): DecideQueueEntry {
  return {
    id,
    kind: 'exception',
    item: {
      id,
      title: 'Calendar connection lost',
      text: 'The calendar service stopped responding',
      surface: 'presence',
      created_at: '2026-09-01T00:00:00.000Z',
      ...overrides,
    } as never,
  };
}

describe('deriveCardFields', () => {
  it('maps approval why/effect-label from the reason field', () => {
    const fields = deriveCardFields(approval('a1'));
    expect(fields.why).toBe('Contains a client commitment');
    expect(fields.effectLabelKey).toBe('decide_effect_approval');
    expect(fields.effect).toBeUndefined();
    expect(fields.evidenceHref).toBeUndefined();
    expect(fields.tenantSlug).toBeUndefined();
  });

  it('omits why for an approval item with an empty reason (absent-field case)', () => {
    const fields = deriveCardFields(approval('a2', { reason: '' }));
    expect(fields.why).toBeUndefined();
  });

  it('maps hygiene why to the raw reason code (translated by the caller) and decide_options', () => {
    const fields = deriveCardFields(hygiene('h1', { reason: 'awaiting_gate' }));
    expect(fields.why).toBe('awaiting_gate');
    expect(fields.effectLabelKey).toBe('decide_options');
    expect(fields.effect).toBeUndefined();
  });

  it('maps memory why to the summary and has no effect column', () => {
    const fields = deriveCardFields(memory('m1'));
    expect(fields.why).toBe('Always confirm budget before booking travel');
    expect(fields.effectLabelKey).toBeUndefined();
  });

  it('maps outcome why to the summary and has no effect column', () => {
    const fields = deriveCardFields(outcome('o1'));
    expect(fields.why).toBe('Draft ready for review');
    expect(fields.effectLabelKey).toBeUndefined();
  });

  it('omits why for an outcome item with an empty summary (absent-field case)', () => {
    const fields = deriveCardFields(outcome('o2', { summary: '' }));
    expect(fields.why).toBeUndefined();
  });

  it('maps exception why to the text and decide_effect_action', () => {
    const fields = deriveCardFields(exception('e1'));
    expect(fields.why).toBe('The calendar service stopped responding');
    expect(fields.effectLabelKey).toBe('decide_effect_action');
  });
});

describe('hasEffectColumn', () => {
  it('is false when the label is set but the body is absent (today, for every kind)', () => {
    expect(hasEffectColumn(deriveCardFields(approval('a1')))).toBe(false);
    expect(hasEffectColumn(deriveCardFields(exception('e1')))).toBe(false);
    expect(hasEffectColumn(deriveCardFields(hygiene('h1')))).toBe(false);
  });

  it('is true only once both a label and a body are present', () => {
    expect(
      hasEffectColumn({ effectLabelKey: 'decide_options', effect: 'Will restart the task' })
    ).toBe(true);
    expect(hasEffectColumn({ effectLabelKey: 'decide_options' })).toBe(false);
    expect(hasEffectColumn({ effect: 'orphan text' })).toBe(false);
  });
});

describe('groupDecideQueue', () => {
  const items = [approval('a1'), hygiene('h1'), memory('m1'), outcome('o1'), exception('e1')];

  it('keeps every item in queue when nothing is deferred', () => {
    const grouped = groupDecideQueue(items, []);
    expect(grouped.queue.map((entry) => entry.id)).toEqual(['a1', 'h1', 'm1', 'o1', 'e1']);
    expect(grouped.deferred).toEqual([]);
    expect(grouped.countsByKind).toEqual({
      approval: 1,
      hygiene: 1,
      memory: 1,
      outcome: 1,
      exception: 1,
    });
  });

  it('moves deferred ids into `deferred` and excludes them from queue and counts', () => {
    const grouped = groupDecideQueue(items, new Set(['h1', 'o1']));
    expect(grouped.queue.map((entry) => entry.id)).toEqual(['a1', 'm1', 'e1']);
    expect(grouped.deferred.map((entry) => entry.id)).toEqual(['h1', 'o1']);
    expect(grouped.countsByKind).toEqual({
      approval: 1,
      hygiene: 0,
      memory: 1,
      outcome: 0,
      exception: 1,
    });
  });

  it('preserves input order within both the queue and deferred arrays', () => {
    const grouped = groupDecideQueue(items, ['a1', 'e1']);
    expect(grouped.deferred.map((entry) => entry.id)).toEqual(['a1', 'e1']);
    expect(grouped.queue.map((entry) => entry.id)).toEqual(['h1', 'm1', 'o1']);
  });

  it('accepts a plain array of deferred ids as well as a Set', () => {
    const grouped = groupDecideQueue(items, ['m1']);
    expect(grouped.queue.map((entry) => entry.id)).not.toContain('m1');
    expect(grouped.deferred.map((entry) => entry.id)).toEqual(['m1']);
  });

  it('returns an empty queue and zeroed counts for an empty input', () => {
    const grouped = groupDecideQueue([], []);
    expect(grouped.queue).toEqual([]);
    expect(grouped.deferred).toEqual([]);
    expect(grouped.countsByKind).toEqual({
      approval: 0,
      hygiene: 0,
      memory: 0,
      outcome: 0,
      exception: 0,
    });
  });
});

describe('presentKinds', () => {
  it('returns only kinds with a non-zero count, in the fixed FD-04 order', () => {
    expect(presentKinds({ approval: 0, hygiene: 2, memory: 0, outcome: 1, exception: 0 })).toEqual([
      'hygiene',
      'outcome',
    ]);
  });

  it('returns an empty array when every count is zero', () => {
    expect(presentKinds({ approval: 0, hygiene: 0, memory: 0, outcome: 0, exception: 0 })).toEqual(
      []
    );
  });
});
