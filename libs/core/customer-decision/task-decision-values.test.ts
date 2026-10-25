import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_CUSTOMER_DECISIONS_HEADING,
  ConfidentialTaskDecisionValues,
  scrubTaskResponseValues,
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

  const shortValues = (...values: unknown[]) =>
    new ConfidentialTaskDecisionValues(
      { tenantSlug: 'acme-corp', caseId: 'case-a', consumer: 'c' },
      values.map((value, index) => ({
        proposal_id: `tp-${index}`,
        agenda_id: 'agd-test0001',
        entry_id: `e${index}`,
        item: 'I',
        key: `k${index}`,
        question: 'Q?',
        decision_id: `D-000${index + 1}`,
        value,
      }))
    );

  it('scrubs short values only as words of their own (Latin, numbers, Japanese)', () => {
    const values = shortValues('yes', 'A', '5%', 'はい', '承認');
    expect(values.scrub('The answer was yes, plan A at 5% — はい、承認です')).toBe(
      'The answer was [customer decision D-0001], plan [customer decision D-0002] at [customer decision D-0003] — [customer decision D-0004]、[customer decision D-0005]です'
    );
    // Never inside a longer word or number.
    const kept = 'yesterday an Apple rose 15% はいけい 承認者';
    expect(values.scrub(kept)).toBe(kept);
    // A replacement is never scrubbed again (D, decision, customer are not values here).
    expect(shortValues('D').scrub('pick D now')).toBe('pick [customer decision D-0001] now');
  });

  it('scrubs every string of a task result except the proposals it makes', () => {
    const values = holder();
    const response = {
      taskResult: {
        summary: `done ${SENTINEL}`,
        artifacts: [{ path: `out/${SENTINEL}.md`, kind: 'doc' }],
        verification_done: ['ok'],
        gaps: [],
        needs: [],
        acceptance_evidence: [
          {
            criterion: `ship ${SENTINEL}`,
            status: 'passed' as const,
            evidence: `said ${SENTINEL}`,
          },
        ],
        review_findings: [{ severity: 'nit' as const, location: SENTINEL, instruction: 'x' }],
        knowledge_feedback: { used: [SENTINEL], not_used: [], missing_topics: [SENTINEL] },
        customer_decisions: [
          {
            question: 'Q?',
            item: 'I',
            key: 'k',
            proposed_value: SENTINEL,
            requires_customer: false,
          },
        ],
      },
      notes: [`note ${SENTINEL}`],
      parseErrors: [`bad ${SENTINEL}`],
      surfaceParseErrors: [],
    };
    const original = response.taskResult;
    scrubTaskResponseValues(values, response);
    // The caller keeps the original for its in-memory checks.
    expect(original.summary).toBe(`done ${SENTINEL}`);
    const scrubbed = response.taskResult;
    const { customer_decisions, artifacts, knowledge_feedback, ...rest } = scrubbed;
    expect(JSON.stringify([rest, response.notes, response.parseErrors])).not.toContain(SENTINEL);
    expect(knowledge_feedback.missing_topics).toEqual(['[customer decision D-0002]']);
    // Not free text: proposals, artifact paths, reported knowledge paths, enum fields.
    expect(customer_decisions[0].proposed_value).toBe(SENTINEL);
    expect(artifacts[0].path).toBe(`out/${SENTINEL}.md`);
    expect(knowledge_feedback.used).toEqual([SENTINEL]);
    expect(scrubbed.review_findings[0].severity).toBe('nit');
    expect(scrubbed.acceptance_evidence[0].status).toBe('passed');
  });

  it('is idempotent: markers are kept, even when a value matches inside one', () => {
    // "decision" and "D-0001" both occur inside the marker the first pass writes.
    const values = shortValues('decision', 'D-0001', 'ok');
    const once = values.scrub('the decision was ok, see D-0001');
    expect(once).toBe(
      'the [customer decision D-0001] was [customer decision D-0003], see [customer decision D-0002]'
    );
    expect(values.scrub(once)).toBe(once);
    // Best-of-N style double pass over a whole result changes nothing either.
    const result = { summary: once, gaps: [once] };
    expect(values.scrubValue(values.scrubValue(result))).toEqual(values.scrubValue(result));
  });

  it('never touches other characters (private-use included), however many matches', () => {
    const values = shortValues('yes');
    const privateUse = '\uE000\uE100\uE001 \uF8FF';
    expect(values.scrub(`${privateUse} yes ${privateUse}`)).toBe(
      `${privateUse} [customer decision D-0001] ${privateUse}`
    );
    const many = Array.from({ length: 7000 }, () => 'yes').join(' ');
    const scrubbed = values.scrub(many);
    expect(scrubbed.split('[customer decision D-0001]')).toHaveLength(7001);
    expect(scrubbed).not.toMatch(/\byes\b/u);
  });

  it('matches short Latin forms case-insensitively, still as whole words', () => {
    const values = shortValues('yes', 'ok');
    expect(values.scrub('YES, Ok — yesterday, okay')).toBe(
      '[customer decision D-0001], [customer decision D-0002] — yesterday, okay'
    );
  });

  it('names unconfirmed proposals by id only, and serializes them as ids', () => {
    const values = new ConfidentialTaskDecisionValues(
      { tenantSlug: 'acme-corp', caseId: 'case-a', consumer: 'c' },
      [],
      [
        { proposal_id: 'tp-bbbbbbbbbbbbbbbb', reason: 'decision_not_recorded' },
        { proposal_id: 'tp-aaaaaaaaaaaaaaaa', reason: 'changed_after_completion' },
      ]
    );
    expect(values.isEmpty).toBe(false);
    expect(values.count).toBe(0);
    expect(JSON.parse(JSON.stringify(values))).toEqual({
      count: 0,
      decision_ids: [],
      unconfirmed_proposal_ids: ['tp-aaaaaaaaaaaaaaaa', 'tp-bbbbbbbbbbbbbbbb'],
    });
    const text = values.promptLines().join('\n');
    expect(text).toContain('tp-aaaaaaaaaaaaaaaa changed after this task completed');
    expect(text).toContain('tp-bbbbbbbbbbbbbbbb is no longer recorded');
    expect(text).not.toContain('confirmed answers to the questions');
    // Where the tier gate would refuse values: a count, no proposal id.
    const counted = values.promptLines({ proposalIds: false }).join('\n');
    expect(counted).toContain("2 of this task's customer decisions changed after it completed");
    expect(counted).not.toMatch(/tp-[a-f0-9]/u);
    expect(values.knowledgeRefs()).toEqual([
      'customer-decision:case-a#tp-aaaaaaaaaaaaaaaa',
      'customer-decision:case-a#tp-bbbbbbbbbbbbbbbb',
    ]);
  });
});
