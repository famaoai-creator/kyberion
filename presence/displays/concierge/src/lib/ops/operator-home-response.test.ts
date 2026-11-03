import { describe, expect, it } from 'vitest';
import { parseOperatorHomeResponse } from './operator-home-response';

const summary = {
  generatedAt: '2026-09-04T00:00:00.000Z',
  status: 'ready',
  statusLabel: 'ready',
  statusDetail: 'No blocking issues detected.',
  counts: {
    activeMissions: 1,
    recentlyActiveMissions: 1,
    blockedMissions: 0,
    pendingApprovals: 0,
    clarificationQuestions: 0,
    unreadInbox: 0,
    totalInbox: 0,
    pendingQualityDecisions: 0,
  },
  activeMissions: [
    {
      missionId: 'M-1',
      status: 'active',
      tier: 'confidential',
      artifactKinds: ['markdown'],
      artifactCount: 1,
    },
  ],
  pendingApprovals: [],
  inboxEntries: [],
  costSummary: {
    totalTokens: 10,
    totalUsd: 0.1,
    entryCount: 1,
    missionCount: 1,
    overBudget: false,
    missionBreakdown: [{ missionId: 'M-1', tokens: 10, usd: 0.1, entryCount: 1 }],
  },
  nextAction: { title: 'Keep monitoring', reason: 'No action', next_action_type: 'open_docs' },
};

describe('operator home response boundary', () => {
  it('accepts a typed operator home response', () => {
    expect(parseOperatorHomeResponse({ summary })).toEqual({ summary });
  });

  it.each([
    { summary: { ...summary, status: 'unknown' } },
    { summary: { ...summary, counts: { ...summary.counts, activeMissions: -1 } } },
    {
      summary: {
        ...summary,
        activeMissions: [{ ...summary.activeMissions[0], tier: 'private' }],
      },
    },
    {
      summary: {
        ...summary,
        costSummary: { ...summary.costSummary, missionBreakdown: [{ missionId: 'M-1', usd: -1 }] },
      },
    },
    {
      summary: {
        ...summary,
        nextAction: { ...summary.nextAction, next_action_type: 'execute' },
      },
    },
    { summary: { ...summary, pendingApprovals: [null] } },
    { summary: { ...summary, inboxEntries: [{ entry_id: 'inbox-1', status: 'unread' }] } },
    JSON.parse('{"summary":{"__proto__":{}}}'),
    [],
  ])('rejects malformed operator home response: %p', (value) => {
    expect(parseOperatorHomeResponse(value)).toBeUndefined();
  });
});
