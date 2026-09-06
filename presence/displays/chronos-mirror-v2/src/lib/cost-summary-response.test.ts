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
