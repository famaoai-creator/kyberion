import { describe, expect, it } from 'vitest';
import { parseCostSummaryResponse } from './cost-summary-response';

const summary = {
  totalTokens: 100,
  totalUsd: 0.25,
  entryCount: 2,
  missionCount: 1,
  since: '2026-09-04',
  budgetUsd: 1,
  remainingUsd: 0.75,
  overBudget: false,
  generation: { actualUsd: 0.1, settledJobs: 1, awaitingActualCost: 0 },
  missionBreakdown: [{ missionId: 'M-1', tokens: 100, usd: 0.25, entryCount: 2 }],
};

describe('cost summary response boundary', () => {
  it('accepts a typed cost summary response', () => {
    expect(parseCostSummaryResponse({ summary })).toEqual({ summary });
  });

  it('accepts additive accounting fields while retaining old payload compatibility', () => {
    const withCoverage = {
      ...summary,
      referenceUsd: 0.8,
      referenceCostCalls: 1,
      includedCalls: 1,
      unknownCostCalls: 1,
      actualCostCalls: 0,
      estimatedCostCalls: 0,
      costComplete: false,
      partialNotice: 'Partial scope',
      withheldPartitions: 1,
    };
    expect(parseCostSummaryResponse({ summary: withCoverage })).toEqual({ summary: withCoverage });
    expect(parseCostSummaryResponse({ summary })).toEqual({ summary });
  });

  it.each([
    { referenceUsd: -1 },
    { referenceUsd: Infinity },
    { referenceCostCalls: 0.5 },
    { includedCalls: '1' },
    { unknownCostCalls: -1 },
    { actualCostCalls: NaN },
    { estimatedCostCalls: null },
    { costComplete: 'true' },
    { costComplete: true, unknownCostCalls: 1 },
  ])('rejects malformed optional accounting fields %j', (patch) => {
    expect(parseCostSummaryResponse({ summary: { ...summary, ...patch } })).toBeUndefined();
    expect(
      parseCostSummaryResponse({
        summary: { ...summary, missionBreakdown: [{ ...summary.missionBreakdown[0], ...patch }] },
      })
    ).toBeUndefined();
  });

  it.each([{ partialNotice: 3 }, { withheldPartitions: 0.5 }])(
    'rejects malformed optional visibility metadata %j',
    (patch) => {
      expect(parseCostSummaryResponse({ summary: { ...summary, ...patch } })).toBeUndefined();
    }
  );

  it.each([
    { summary: { ...summary, totalUsd: Number.NaN } },
    { summary: { ...summary, entryCount: 1.5 } },
    { summary: { ...summary, remainingUsd: -1 } },
    { summary: { ...summary, generation: { ...summary.generation, settledJobs: '1' } } },
    { summary: { ...summary, missionBreakdown: [{ ...summary.missionBreakdown[0], usd: -1 }] } },
    {
      summary: { ...summary, missionBreakdown: [{ ...summary.missionBreakdown[0], lastSeen: 42 }] },
    },
    JSON.parse(
      '{"summary":{"__proto__":{},"totalTokens":0,"totalUsd":0,"entryCount":0,"missionCount":0,"overBudget":false,"generation":{"actualUsd":0,"settledJobs":0,"awaitingActualCost":0},"missionBreakdown":[]}}'
    ),
    [],
  ])('rejects malformed cost summary response: %p', (value) => {
    expect(parseCostSummaryResponse(value)).toBeUndefined();
  });
});
