import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectOperatorHomeSummary: vi.fn(),
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
}));

vi.mock('@agent/core', () => ({
  collectOperatorHomeSummary: mocks.collectOperatorHomeSummary,
}));

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));

import { GET } from './route.js';

describe('operator-home route', () => {
  beforeEach(() => {
    mocks.collectOperatorHomeSummary.mockReset();
    mocks.guardRequest.mockReset();
    mocks.requireChronosAccess.mockReset();
    mocks.guardRequest.mockReturnValue(null);
    mocks.requireChronosAccess.mockReturnValue(null);
  });

  it('returns the aggregated operator home summary', async () => {
    mocks.collectOperatorHomeSummary.mockReturnValue({
      generatedAt: '2026-07-06T00:00:00.000Z',
      status: 'attention',
      statusLabel: 'attention required',
      statusDetail: '1 approval pending',
      counts: {
        activeMissions: 1,
        blockedMissions: 0,
        pendingApprovals: 1,
        clarificationQuestions: 0,
        unreadInbox: 1,
        totalInbox: 1,
      },
      activeMissions: [],
      pendingApprovals: [],
      inboxEntries: [],
      costSummary: {
        totalTokens: 0,
        totalUsd: 0,
        entryCount: 0,
        missionCount: 0,
        remainingUsd: null,
        overBudget: false,
        missionBreakdown: [],
      },
      nextAction: {
        title: 'Review the approval queue',
        reason: 'pending review',
        next_action_type: 'run_command',
        suggested_command: 'pnpm chronos',
      },
    });

    const response = await GET(new Request('http://localhost/api/operator-home?limit=5') as any);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      summary: { statusLabel: string; counts: { pendingApprovals: number } };
    };
    expect(payload.summary.statusLabel).toBe('attention required');
    expect(payload.summary.counts.pendingApprovals).toBe(1);
  });
});
