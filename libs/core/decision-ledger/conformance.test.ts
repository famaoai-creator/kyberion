import { describe, expect, it } from 'vitest';
import { buildLock, checkConformance } from './conformance.js';
import type { DecisionRecord, DecisionObservedSet } from './model.js';

const NOW = '2026-09-14T00:00:00.000Z';

function decided(
  id: string,
  key: string,
  value: unknown,
  extra: Partial<DecisionRecord> = {}
): DecisionRecord {
  return {
    id,
    case_id: 'case-a',
    item: `SCR-1#${key}`,
    key,
    level: 'product-fixed',
    state: 'decided',
    value,
    basis: [{ ref: `SRC-${id}`, version: 'r1' }],
    decided_by: { kind: 'human', id: 'user:alice', role: 'owner' },
    decided_at: NOW,
    origin: 'transcribed',
    status: 'active',
    ...extra,
  };
}

/** Same verdict distribution the tenant-side PoC reached by hand, expressed with neutral keys. */
const decisions: DecisionRecord[] = [
  decided('D-0001', 'export.columns', ['a', 'b', 'c', 'd', 'e', 'f']),
  decided('D-0002', 'export.charset', { charset: 'shift_jis' }),
  decided('D-0003', 'note.max_length', { max: 30, unit: 'byte' }),
  decided('D-0004', 'message.order_text', { id: 'M-6', text: 'from before to' }),
  decided('D-0005', 'filter.options', { labels: ['1', '2', '3', '4'], default: '1' }),
  decided('D-0006', 'filter.min_date', { years_back: 2, anchor: 'month-start' }),
  decided('D-0007', 'note.disallowed', '[xyz]'),
  decided('D-0008', 'export.control_count', 1),
  decided('D-0009', 'list.total_places', { same_value: true }),
  decided('D-0010', 'filter.custom_disabled', true),
  decided('D-0011', 'spec.primary_source', { doc: 'REV-2' }),
  decided('D-0012', 'amount.format', { pattern: '#,##0' }),
  // superseded and proposed records never enter the check
  decided('D-0013', 'export.columns', ['old'], { status: 'superseded' }),
  decided('D-0014', 'other.key', 1, { state: 'proposed' }),
];

const observed: DecisionObservedSet = {
  case_id: 'case-a',
  impl: { repo: 'impl-repo', commit: 'abc1234' },
  observed_at: NOW,
  observations: [
    {
      key: 'export.columns',
      value: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      ref: 'csv.ts:13',
    },
    { key: 'export.charset', value: { charset: 'utf-8', bom: true }, ref: 'csv.ts:69' },
    { key: 'note.max_length', value: { unit: 'codepoint', max: 15 }, ref: 'memo.ts:11' },
    {
      key: 'message.order_text',
      value: { id: 'M-old', text: 'from before to (old)' },
      ref: 'filter.ts:16',
    },
    {
      key: 'filter.options',
      value: { default: '1', labels: ['1', '2', '3', '4'] },
      ref: 'filter.ts:30',
    },
    {
      key: 'filter.min_date',
      value: { anchor: 'month-start', years_back: 2 },
      ref: 'filter.ts:156',
    },
    { key: 'note.disallowed', value: '[xyz]', ref: 'memo.ts:3' },
    { key: 'export.control_count', value: 1, ref: 'screen.tsx:256' },
    { key: 'list.total_places', value: { same_value: true }, ref: 'screen.tsx:166' },
    { key: 'filter.custom_disabled', value: true, ref: 'bar.tsx:115' },
    { key: 'spec.primary_source', value: { doc: 'REV-2' }, ref: 'src', stale: true },
  ],
};

describe('checkConformance', () => {
  it('reaches the PoC distribution: 6 match, 4 conflict, 1 stale, 1 unprobed → red', () => {
    const report = checkConformance(decisions, observed, { now: NOW });
    expect(report.tally).toEqual({ match: 6, conflict: 4, stale: 1, unprobed: 1 });
    expect(report.status).toBe('red');
    expect(report.checks.map((c) => c.decision)).not.toContain('D-0013');
    expect(report.checks.map((c) => c.decision)).not.toContain('D-0014');
    const unprobed = report.checks.find((c) => c.verdict === 'unprobed');
    expect(unprobed?.key).toBe('amount.format');
  });

  it('ignores key order when comparing values', () => {
    const report = checkConformance(
      [decided('D-0001', 'k.a', { x: 1, y: { p: 2, q: 3 } })],
      {
        ...observed,
        observations: [{ key: 'k.a', value: { y: { q: 3, p: 2 }, x: 1 }, ref: 'f:1' }],
      },
      { now: NOW }
    );
    expect(report.status).toBe('green');
  });

  it('lets a caller override equality for one key without teaching the module a domain', () => {
    const report = checkConformance(
      [decided('D-0002', 'export.charset', { charset: 'Shift_JIS' })],
      {
        ...observed,
        observations: [{ key: 'export.charset', value: { charset: 'sjis' }, ref: 'f:1' }],
      },
      {
        now: NOW,
        comparators: {
          'export.charset': (a, b) =>
            /shift|sjis/iu.test(String((a as { charset: string }).charset)) &&
            /shift|sjis/iu.test(String((b as { charset: string }).charset)),
        },
      }
    );
    expect(report.status).toBe('green');
  });

  it('is green with nothing observed only when nothing is decided; otherwise everything is unprobed', () => {
    expect(checkConformance([], undefined, { now: NOW }).status).toBe('green');
    const report = checkConformance(decisions.slice(0, 2), undefined, { now: NOW });
    expect(report.tally).toEqual({ unprobed: 2 });
    expect(report.status).toBe('green');
  });
});

describe('buildLock', () => {
  it('freezes only active decided records with their basis refs and versions', () => {
    const report = checkConformance(decisions, observed, { now: NOW });
    const lock = buildLock(decisions, report);
    expect(lock.version).toBe('1.0.0');
    expect(lock.status).toBe('red');
    expect(lock.impl).toEqual(observed.impl);
    expect(lock.decisions).toHaveLength(12);
    expect(lock.decisions[0]).toEqual({
      id: 'D-0001',
      item: 'SCR-1#export.columns',
      key: 'export.columns',
      level: 'product-fixed',
      value: ['a', 'b', 'c', 'd', 'e', 'f'],
      basis: [{ ref: 'SRC-D-0001', version: 'r1' }],
    });
  });
});
