import { describe, expect, it } from 'vitest';
import { costAmountLabel, referenceAmountLabel } from './cost-summary-presentation';

describe('cost presentation certainty', () => {
  it('does not render unknown-only or legacy unverified zero subtotals as free', () => {
    expect(costAmountLabel(0, { costComplete: false, unknownCostCalls: 3 }, 'en')).toBe(
      'Cost unavailable'
    );
    expect(costAmountLabel(0, undefined, 'ja')).toBe('費用不明');
    expect(costAmountLabel(undefined, undefined, 'en')).toBe('-');
  });
  it('distinguishes subscription inclusion from provider-confirmed zero', () => {
    expect(costAmountLabel(0, { costComplete: true, includedCalls: 2 }, 'en')).toBe(
      'Subscription-included'
    );
    expect(costAmountLabel(0, { costComplete: true, actualCostCalls: 1 }, 'en')).toBe('$0.000');
    expect(
      costAmountLabel(0, { costComplete: false, includedCalls: 2, unknownCostCalls: 1 }, 'en')
    ).toBe('Cost unavailable');
    expect(costAmountLabel(1.25, { costComplete: false, unknownCostCalls: 1 }, 'en')).toBe(
      '$1.250'
    );
  });
  it('requires reference-cost evidence before displaying a zero reference estimate', () => {
    expect(referenceAmountLabel({ referenceUsd: 0, referenceCostCalls: 0 }, 'en')).toBe(
      'Cost unavailable'
    );
    expect(referenceAmountLabel({ referenceUsd: 0, referenceCostCalls: 1 }, 'en')).toBe('$0.000');
    expect(referenceAmountLabel({ referenceUsd: 0.2 }, 'ja')).toBe('$0.200');
  });
});
