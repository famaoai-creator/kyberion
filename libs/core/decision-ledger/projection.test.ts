import { describe, expect, it } from 'vitest';
import { buildProjectionBrief } from './projection.js';
import type { DecisionObservedSet, DecisionRecord } from './model.js';

const NOW = '2026-09-14T00:00:00.000Z';

function record(id: string, overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id,
    case_id: 'case-a',
    item: 'SCR-1#B1',
    key: 'k.a',
    level: 'product-fixed',
    state: 'proposed',
    value: null,
    basis: [],
    origin: 'observation',
    status: 'active',
    ...overrides,
  };
}

const ledger: DecisionRecord[] = [
  record('D-0001', {
    key: 'csv.columns',
    state: 'decided',
    value: ['a', 'b'],
    basis: [{ ref: 'QA-1', version: 'r1' }],
    decided_by: { kind: 'human', id: 'user:alice', role: 'owner' },
  }),
  record('D-0002', {
    key: 'memo.max',
    state: 'decided',
    value: 30,
    basis: [{ ref: 'V-201', version: 'r1' }],
    decided_by: { kind: 'human', id: 'user:alice', role: 'owner' },
  }),
  record('D-0003', {
    key: 'balance.kind',
    level: 'customer-value',
    state: 'proposed',
    item: 'SCR-2#B5',
  }),
  record('D-0004', {
    key: 'axis.x',
    level: 'product-axis',
    state: 'proposed',
    pending_reason: 'axis_without_options',
  }),
  record('D-0005', { key: 'old', state: 'decided', status: 'superseded', value: 1 }),
  record('D-0006', { key: 'other', case_id: 'case-b' }),
];

const observed: DecisionObservedSet = {
  case_id: 'case-a',
  impl: { repo: 'impl', commit: 'abc' },
  observed_at: NOW,
  observations: [{ key: 'csv.columns', value: ['a', 'b', 'c'], ref: 'csv.ts:13' }],
};

describe('buildProjectionBrief', () => {
  it('joins active records of the case with verdicts and hearing answers', () => {
    const brief = buildProjectionBrief(ledger, observed, {
      caseId: 'case-a',
      now: NOW,
      answers: [
        { id: 'D-0003', answer: 'previous-day', source_turn: 't1' },
        { id: 'D-0001', answer: 'ignored' },
      ],
    });
    expect(brief.rows.map((row) => [row.id, row.verdict])).toEqual([
      ['D-0001', 'conflict'],
      ['D-0002', 'unprobed'],
      ['D-0003', 'open'],
      ['D-0004', 'open'],
    ]);
    expect(brief.rows[0]).toMatchObject({
      observed: ['a', 'b', 'c'],
      impl_ref: 'csv.ts:13',
      decided_by: 'user:alice',
      basis_refs: ['QA-1'],
    });
    expect(brief.rows[2].answer).toBe('previous-day');
    expect(brief.rows[0].answer).toBeUndefined();
    expect(brief.rows[3].pending_reason).toBe('axis_without_options');
    expect(brief.tally).toEqual({ match: 0, conflict: 1, stale: 0, unprobed: 1, open: 2 });
    expect(brief.red).toBe(true);
    expect(brief.impl).toEqual(observed.impl);
  });

  it('narrows open rows to the asked actor but always keeps decided rows', () => {
    const brief = buildProjectionBrief(ledger, undefined, {
      caseId: 'case-a',
      now: NOW,
      actor: 'customer',
    });
    expect(brief.rows.map((row) => row.id)).toEqual(['D-0001', 'D-0002', 'D-0003']);
    expect(brief.red).toBe(false);
    expect(brief.impl).toBeUndefined();
  });
});
