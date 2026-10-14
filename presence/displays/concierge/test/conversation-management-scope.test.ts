import { describe, expect, it } from 'vitest';
import {
  conversationScopeFromQuery,
  sameConversationRequestScope,
  parsePendingConversationRequest,
  prepareConversationRequest,
} from '../src/lib/conversation-request';

describe('conversation from company management', () => {
  it('uses management precedence when both aliases are present', () => {
    expect(
      conversationScopeFromQuery(
        'session',
        'acme',
        new URLSearchParams(
          'organization_id=org-a&organizationId=org-b&project_id=project-a&projectId=project-b'
        )
      )
    ).toEqual({
      sessionId: 'session',
      tenant: 'acme',
      organizationId: 'org-a',
      projectId: 'project-a',
    });
  });
  it('keeps the selected hierarchy in management snake-case URLs', () => {
    const snake = conversationScopeFromQuery(
      'session',
      'acme',
      new URLSearchParams('organization_id=org-a&project_id=project-a')
    );
    const camel = conversationScopeFromQuery(
      'session',
      'acme',
      new URLSearchParams('organizationId=org-a&projectId=project-a')
    );
    expect(snake).toEqual({
      sessionId: 'session',
      tenant: 'acme',
      organizationId: 'org-a',
      projectId: 'project-a',
    });
    expect(sameConversationRequestScope(snake, camel)).toBe(true);
  });
  it('rejects a saved retry after the management project changes', () => {
    const scope = conversationScopeFromQuery(
      'session',
      'acme',
      new URLSearchParams('organization_id=org-a&project_id=project-a')
    );
    const saved = prepareConversationRequest(
      'Prepare a plan',
      scope,
      'en',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1,
      null
    );
    const next = conversationScopeFromQuery(
      'session',
      'acme',
      new URLSearchParams('organization_id=org-a&project_id=project-b')
    );
    expect(parsePendingConversationRequest(saved, next, 'en')).toBeUndefined();
  });
});
