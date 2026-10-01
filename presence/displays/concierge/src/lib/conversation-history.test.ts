import { describe, expect, it } from 'vitest';
import { parseConversationHistory } from './conversation-history';

const sessionId = `concierge-${'a'.repeat(64)}`;

describe('display-only conversation restoration', () => {
  it('removes approval actions and intent metadata rather than replaying them', () => {
    expect(
      parseConversationHistory({
        sessionId,
        pending: 0,
        messages: [
          {
            id: 'old-reply',
            role: 'secretary',
            text: 'Please approve',
            nextActions: [{ id: 'approve', label: 'Approve' }],
            intentResolution: { authority_level: 'approval_required' },
          },
        ],
      })
    ).toEqual({
      sessionId,
      pending: 0,
      messages: [
        {
          id: 'old-reply',
          role: 'secretary',
          text: 'Please approve',
        },
      ],
    });
  });

  it.each([
    { sessionId: '../other-user', pending: 0, messages: [] },
    { sessionId, pending: -1, messages: [] },
    { sessionId, pending: 0, messages: [{ id: 'x', role: 'system', text: 'execute' }] },
    { sessionId, pending: 0, messages: [{ id: 'x', role: 'user', text: {} }] },
    { sessionId, pending: 0, messages: Array(101).fill({ id: 'x', role: 'user', text: 'x' }) },
  ])('rejects malformed or unbounded restoration: %j', (value) => {
    expect(parseConversationHistory(value)).toBeUndefined();
  });
});
