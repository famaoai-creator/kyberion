import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_CUSTOMER_DECISIONS_HEADING,
  ConfidentialTaskDecisionValues,
} from './task-decision-values.js';

const SENTINEL = 'release-on-nov-first-SENTINEL';

function holder() {
  return new ConfidentialTaskDecisionValues(
    { tenantSlug: 'acme-corp', caseId: 'case-a', consumer: 'mission-MSN-1.impl' },
    [
      {
        proposal_id: 'tp-0123456789abcdef',
        agenda_id: 'agd-test0001',
        entry_id: 'release',
        item: 'RELEASE',
        key: 'release.date',
        question: 'Which release date?',
        decision_id: 'D-0002',
        value: SENTINEL,
        option_label: 'First of November',
      },
      {
        proposal_id: 'tp-fedcba9876543210',
        agenda_id: 'agd-test0001',
        entry_id: 'budget',
        item: 'MONEY',
        key: 'budget.cap',
        question: 'Budget cap?',
        decision_id: 'D-0001',
        value: { amount: 1250000, approved: true, note: 'board-approved-cap' },
      },
    ]
  );
}

describe('ConfidentialTaskDecisionValues (CD-09)', () => {
  it('serializes to ids only (JSON.stringify, util.inspect, spread, template)', () => {
    const values = holder();
    const shown = [
      JSON.stringify(values),
      JSON.stringify({ nested: { values } }),
      inspect(values, { depth: 10, showHidden: true }),
      inspect({ values }, { depth: 10 }),
      JSON.stringify({ ...values }),
      `${values}`,
    ].join('\n');
    expect(JSON.parse(JSON.stringify(values))).toEqual({
      count: 2,
      decision_ids: ['D-0001', 'D-0002'],
    });
    expect(shown).not.toMatch(
      /SENTINEL|release\.date|RELEASE|1250000|board-approved|November|Which release|acme-corp|budget/u
    );
    expect(values.knowledgeRefs()).toEqual([
      'customer-decision:case-a#D-0001',
      'customer-decision:case-a#D-0002',
    ]);
  });

  it('renders the one prompt section that carries the values', () => {
    const lines = holder().promptLines();
    expect(lines[0]).toBe(CONFIRMED_CUSTOMER_DECISIONS_HEADING);
    const text = lines.join('\n');
    expect(text).toContain(SENTINEL);
    expect(text).toContain('[D-0002] Which release date?');
    expect(text).toContain('First of November');
    expect(
      new ConfidentialTaskDecisionValues(
        { tenantSlug: 'acme-corp', caseId: 'case-a', consumer: 'c' },
        []
      ).promptLines()
    ).toEqual([]);
  });

  it('scrubs echoed values, labels and number forms; short forms stay', () => {
    const scrubbed = holder().scrub(
      `Shipped for ${SENTINEL.toLowerCase()} (First of November) within 1250000 yen, note board-approved-cap; true, ok`
    );
    expect(scrubbed).not.toMatch(/sentinel|November|1250000|board-approved/iu);
    expect(scrubbed).toContain('[customer decision D-0002]');
    expect(scrubbed).toContain('[customer decision D-0001]');
    expect(scrubbed).toContain('true, ok');
    // Nothing to scrub: the text is unchanged.
    expect(holder().scrub('Completed the widget.')).toBe('Completed the widget.');
  });
});
