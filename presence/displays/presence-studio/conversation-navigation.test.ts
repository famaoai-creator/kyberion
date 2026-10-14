import { describe, it, expect } from 'vitest';
import { projectConversationHistory } from '@agent/core/surface/front-desk-conversation-store';
import { projectConversationNavigation } from './conversation-navigation.js';
import type {
  ConversationHistory,
  ConversationHistoryMessage,
} from '@agent/core/surface/front-desk-conversation-history';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
const user = (id: string, requestRefs?: string[]): ConversationHistoryMessage => ({
  id: id + '-user',
  role: 'user',
  text: 'request',
  ...(requestRefs ? { requestRefs } : {}),
});
const history = (messages: ConversationHistoryMessage[]): ConversationHistory => ({
  sessionId: 'concierge-' + 'a'.repeat(64),
  pending: 0,
  messages,
});
describe('display-only request navigation', () => {
  it('does not invent progress or a self link for greetings and original intake', () => {
    expect(
      projectConversationNavigation(history([user(a), user(b, [b])]), []).messages.every(
        (m) => !m.navigation
      )
    ).toBe(true);
  });
  it('links a status/followup to the retained original request', () => {
    expect(
      projectConversationNavigation(history([user(a, [a]), user(b, [a])]), []).messages[1]
        .navigation
    ).toEqual([{ kind: 'request', id: a }]);
  });
  it('suppresses a truncated original instead of linking an unavailable turn', () => {
    expect(
      projectConversationNavigation(history([user(b, [a])]), []).messages[0].navigation
    ).toBeUndefined();
  });
  it('keeps all retained ambiguous candidates without choosing one', () => {
    expect(
      projectConversationNavigation(history([user(a), user(b), user(c, [a, b])]), []).messages[2]
        .navigation
    ).toEqual([
      { kind: 'request', id: a },
      { kind: 'request', id: b },
    ]);
  });
  it('preserves positive session links for legacy runtime work without intake refs', () => {
    expect(
      projectConversationNavigation(history([user(a)]), [
        { session_id: 'session-a', correlation_id: a },
      ]).messages[0].navigation
    ).toEqual([{ kind: 'progress', id: 'session-a' }]);
  });
  it('uses the original correlation, never a new followup ID', () => {
    expect(
      projectConversationNavigation(history([user(a), user(b, [a])]), [
        { session_id: 'session-a', correlation_id: a },
      ]).messages[1].navigation
    ).toEqual([{ kind: 'progress', id: 'session-a' }]);
  });
  it('retains a known session even when the original conversation turn was truncated', () => {
    expect(
      projectConversationNavigation(history([user(b, [a])]), [
        { session_id: 'session-a', correlation_id: a },
      ]).messages[0].navigation
    ).toEqual([{ kind: 'progress', id: 'session-a' }]);
  });
  it('ignores malformed ids and never puts navigation on assistant messages', () => {
    const result = projectConversationNavigation(
      history([{ id: a + '-secretary', role: 'secretary', text: 'reply' }, user(a)]),
      [{ session_id: '../escape', correlation_id: a }]
    );
    expect(result.messages.every((m) => !m.navigation)).toBe(true);
  });
  it('deduplicates session evidence and retains multiple actual sessions', () => {
    const result = projectConversationNavigation(history([user(a)]), [
      { session_id: 's1', correlation_id: a },
      { session_id: 's1', correlation_id: a },
      { session_id: 's2', correlation_id: a },
    ]);
    expect(result.messages[0].navigation).toEqual([
      { kind: 'progress', id: 's1' },
      { kind: 'progress', id: 's2' },
    ]);
  });
  it('suppresses the original after actual core history slicing with execution reports', () => {
    const projected = projectConversationHistory(
      {
        principalId: 'human:fixture',
        role: 'localadmin',
        source: 'token',
        tenantSlugs: ['fixture'],
        organizationIds: 'all',
        projectIds: 'all',
        tierAccess: ['public'],
      },
      {
        version: 5,
        sessionId: 'concierge-' + 'a'.repeat(64),
        turns: [
          {
            id: a,
            text: 'Original',
            createdAt: 1,
            routing: { kind: 'new_request', taskIds: [a], authority: 'none', confidence: 'rule' },
          },
          {
            id: b,
            text: 'Status',
            createdAt: 200,
            routing: { kind: 'status', taskIds: [a], authority: 'none', confidence: 'rule' },
          },
        ],
        taskState: {
          tasks: [
            {
              id: a,
              title: 'Original',
              requestText: 'Original',
              createdAt: 1,
              updates: [],
              state: 'recorded',
            },
          ],
        },
        executionReports: Array.from({ length: 100 }, (_, i) => ({
          id: 'report-' + i,
          requestId: a,
          status: 'uncertain',
          text: 'Recorded report',
          createdAt: i + 2,
        })),
      },
      false
    );
    expect(projected.messages).toHaveLength(100);
    expect(projected.messages.some((m) => m.id === a + '-user')).toBe(false);
    const followup = projectConversationNavigation(projected, []).messages.find(
      (m) => m.id === b + '-user'
    );
    expect(followup?.requestRefs).toEqual([a]);
    expect(followup?.navigation).toBeUndefined();
  });
});
