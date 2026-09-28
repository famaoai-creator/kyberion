import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_OPS_SHADOW_REASON } from './autonomous-ops-gate.js';
import { buildDecisionCard, DECISION_CARD_LIMITS, validateDecisionCard } from './decision-card.js';

const base = { question: 'Ship it?', recommendation: 'Approve.' };

describe('decision card', () => {
  it('defaults to the approve tier and irreversible when nothing says otherwise', () => {
    const card = buildDecisionCard(base);
    expect(card).toMatchObject({ riskTier: 'approve', reversible: false, riskReasons: [] });
  });

  it('takes the stricter tier of the gate and the caller', () => {
    const gate = { decision: 'notify' as const, reason: 'score 4/6', axes: axes(1), score: 4 };
    expect(buildDecisionCard({ ...base, gate, riskTier: 'auto' }).riskTier).toBe('notify');
    expect(buildDecisionCard({ ...base, gate, riskTier: 'approve' }).riskTier).toBe('approve');
  });

  it('adds gate reasons after the caller reasons and drops the shadow note', () => {
    const card = buildDecisionCard({
      ...base,
      riskReasons: ['operator asked'],
      gate: {
        decision: 'approve',
        reason: `score 8/6; never-auto class: secret_mutation; ${AUTONOMOUS_OPS_SHADOW_REASON}`,
        axes: axes(3),
        score: 8,
      },
    });
    expect(card.riskReasons).toEqual([
      'operator asked',
      'score 8/6',
      'never-auto class: secret_mutation',
    ]);
  });

  it('is reversible only when the caller and the gate both agree', () => {
    const reversibleGate = { decision: 'auto' as const, reason: '', axes: axes(1), score: 2 };
    const irreversibleGate = { decision: 'auto' as const, reason: '', axes: axes(2), score: 2 };
    expect(buildDecisionCard({ ...base, gate: reversibleGate }).reversible).toBe(true);
    expect(buildDecisionCard({ ...base, gate: reversibleGate, reversible: false }).reversible).toBe(
      false
    );
    expect(
      buildDecisionCard({ ...base, gate: irreversibleGate, reversible: true }).reversible
    ).toBe(false);
  });

  it('does not call the action reversible when the gate could not score it', () => {
    const unavailable = {
      decision: 'approve' as const,
      reason: 'policy unavailable',
      axes: axes(0),
      score: Number.POSITIVE_INFINITY,
    };
    expect(buildDecisionCard({ ...base, gate: unavailable, reversible: true }).reversible).toBe(
      false
    );
  });

  it('clips over-long reasons instead of refusing the request', () => {
    const card = buildDecisionCard({ ...base, riskReasons: ['x'.repeat(5000)] });
    expect(card.riskReasons[0]).toHaveLength(DECISION_CARD_LIMITS.text);
    expect(card.riskReasons[0].endsWith('…')).toBe(true);
  });

  it('accepts https URLs and repository-relative evidence paths only', () => {
    for (const ref of ['https://example.com/pr/1', 'active/missions/public/M/evidence/b.json']) {
      expect(() => buildDecisionCard({ ...base, evidence: [{ label: 'e', ref }] })).not.toThrow();
    }
    for (const ref of [
      'http://example.com',
      'javascript:alert(1)',
      '/etc/passwd',
      '../secret.json',
      'a/../../b',
      'a\\b',
    ]) {
      expect(() => buildDecisionCard({ ...base, evidence: [{ label: 'e', ref }] })).toThrow(
        /evidence\[0\]\.ref/u
      );
    }
  });

  it('rejects malformed cards', () => {
    const card = buildDecisionCard(base);
    expect(() => validateDecisionCard({ ...card, question: ' ' })).toThrow(/question/u);
    expect(() => validateDecisionCard({ ...card, riskTier: 'never' as never })).toThrow(
      /riskTier/u
    );
    expect(() => validateDecisionCard({ ...card, deadline: 'tomorrow' })).toThrow(/deadline/u);
    expect(() =>
      validateDecisionCard({
        ...card,
        riskReasons: Array.from({ length: DECISION_CARD_LIMITS.reasons + 1 }, () => 'r'),
      })
    ).toThrow(/riskReasons/u);
  });
});

function axes(reversibility: number) {
  return { scope: 1, reversibility, sensitivity: 1, confidence: 1 };
}
