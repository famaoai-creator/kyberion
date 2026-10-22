import { describe, expect, it } from 'vitest';
import {
  LEDGER_TENANT_LABEL_KEY,
  askLedger,
  buildHearingScenarioFromAsk,
  coerceAnswerValue,
  hearingAnswersToPromotions,
  parseDecisionsScenarioId,
  decisionsScenarioId,
} from './hearing-scenario.js';
import type { DecisionRecord } from './model.js';

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
  record('D-0001', { key: 'csv.columns', state: 'proposed' }),
  record('D-0002', { key: 'memo.max', state: 'decided' }),
  record('D-0003', {
    key: 'balance.kind',
    level: 'customer-value',
    state: 'proposed',
    item: 'SCR-2#B5',
  }),
  record('D-0004', { key: 'old.key', state: 'proposed', status: 'superseded' }),
  record('D-0005', { key: 'dropped', state: 'rejected' }),
  record('D-0006', { key: 'axis.x', level: 'product-axis', state: 'observed' }),
];

describe('askLedger', () => {
  it('returns open active records, split by who should answer', () => {
    const all = askLedger(ledger);
    expect(all.map((item) => item.decision.id)).toEqual(['D-0001', 'D-0003', 'D-0006']);
    expect(askLedger(ledger, { actor: 'customer' }).map((i) => i.decision.id)).toEqual(['D-0003']);
    expect(askLedger(ledger, { actor: 'product' }).map((i) => i.decision.id)).toEqual([
      'D-0001',
      'D-0006',
    ]);
  });
});

describe('scenario ids', () => {
  it('round-trips a safe scenario id and rejects unsafe case ids', () => {
    expect(decisionsScenarioId('case-a', 'product')).toBe('decisions-case-a-product');
    expect(parseDecisionsScenarioId('decisions-case-a-customer')).toEqual({
      case_id: 'case-a',
      actor: 'customer',
    });
    expect(parseDecisionsScenarioId('web_app_build')).toBeUndefined();
    expect(() => decisionsScenarioId('../x', 'product')).toThrow(/DECISION_LEDGER_CASE_INVALID/u);
  });
});

describe('buildHearingScenarioFromAsk', () => {
  it('makes one tenant-labelled requirement per open decision, id = decision id', () => {
    const scenario = buildHearingScenarioFromAsk(askLedger(ledger), {
      caseId: 'case-a',
      actor: 'product',
    });
    expect(scenario.id).toBe('decisions-case-a-product');
    expect(scenario.ledger).toEqual({ case_id: 'case-a', actor: 'product', open: 2 });
    expect(scenario.requirements.map((r) => r.id)).toEqual(['D-0001', 'D-0006']);
    expect(scenario.requirements[0]).toMatchObject({
      label_key: LEDGER_TENANT_LABEL_KEY,
      label_source: 'tenant',
      label_text: 'SCR-1#B1 · csv.columns',
    });
    expect(scenario.requirements[0].aliases).toContain('csv.columns');
  });
});

describe('answers → promotions', () => {
  it('parses JSON-looking answers and keeps prose as text', () => {
    expect(coerceAnswerValue('["a","b"]')).toEqual(['a', 'b']);
    expect(coerceAnswerValue('{"max":30}')).toEqual({ max: 30 });
    expect(coerceAnswerValue(' 6 ')).toBe(6);
    expect(coerceAnswerValue('true')).toBe(true);
    expect(coerceAnswerValue('six columns, no currency')).toBe('six columns, no currency');
    expect(coerceAnswerValue('{not json')).toBe('{not json');
  });

  it('skips unanswered requirements and binds each promotion to its hearing turn', () => {
    const decidedBy = { kind: 'human' as const, id: 'user:alice', role: 'owner' as const };
    const promotions = hearingAnswersToPromotions(
      [
        { id: 'D-0001', answer: '["a","b"]', source_turn: 't-1' },
        { id: 'D-0006' },
        { id: 'D-0003', answer: '   ' },
      ],
      { sessionId: 's-1', decidedBy }
    );
    expect(promotions).toEqual([
      {
        promote: 'D-0001',
        value: ['a', 'b'],
        decided_by: decidedBy,
        basis: [{ ref: 'hearing:s-1', version: 'turn:t-1', note: undefined }],
        source_turn: 't-1',
        origin: 'hearing',
      },
    ]);
  });
});
