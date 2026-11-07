import { describe, expect, it } from 'vitest';
import { t } from '../localization/t.js';
import type { VocabularyKey } from '../knowledge/vocabulary-keys.generated.js';
import { decisionReasonText } from './decision-reason-text.js';

describe('decisionReasonText', () => {
  it('recognizes a stored gate reason in any locale and returns its concierge key', () => {
    expect(decisionReasonText('The agent asked for your judgment')).toEqual({
      key: 'ux_b_reason_requested',
    });
    expect(decisionReasonText('エージェント自身が人の判断を求めました')).toEqual({
      key: 'ux_b_reason_requested',
    });
  });

  it('carries the params of a templated reason', () => {
    expect(decisionReasonText('Changes protected files: libs/core/a.ts, scripts/b.ts')).toEqual({
      key: 'ux_b_reason_high_risk_path',
      params: { count: 2 },
    });
    expect(decisionReasonText('リスク点数 5/6')).toEqual({
      key: 'ux_b_reason_score',
      params: { score: '5', max: '6' },
    });
  });

  it('never puts paths or machine codes into the rendered body', () => {
    const stored = [
      'Changes protected files: libs/core/a.ts, scripts/b.ts',
      'A risk axis is at its maximum: blast_radius, reversibility',
      'Always decided by a person: vcs_write, credential_change',
    ];
    for (const text of stored) {
      const reason = decisionReasonText(text);
      expect(reason && 'key' in reason).toBe(true);
      if (!reason || !('key' in reason)) continue;
      for (const locale of ['en', 'ja'] as const) {
        const body = t(`concierge:${reason.key}` as VocabularyKey, reason.params ?? {}, locale);
        expect(body).not.toMatch(/libs\/|scripts\/|blast_radius|vcs_write|_/u);
      }
    }
  });

  it('leaves unknown text alone', () => {
    expect(decisionReasonText('Read-only measurement is the safest next step.')).toBeUndefined();
    expect(decisionReasonText('')).toBeUndefined();
  });

  it('renders the same sentence the decision domain does, in Japanese', () => {
    const reason = decisionReasonText('Hard to undo')!;
    expect('key' in reason && t(`concierge:${reason.key}` as VocabularyKey, {}, 'ja')).toBe(
      t('decision:reason_irreversible', {}, 'ja')
    );
  });
});
