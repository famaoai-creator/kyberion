import { describe, expect, it } from 'vitest';
import {
  conversationFailurePolicy,
  parseConversationMessageResponse,
} from '../src/app/conversation-dock';

const contract = {
  request_id: 'ir-test',
  normalized_intent: 'send_message',
  missing_inputs: [],
  resolution_shape: 'task_session' as const,
  outcome_kind: 'service_change' as const,
  authority_level: 'approval_required' as const,
  next_action: {
    kind: 'request_approval' as const,
    label: 'Approve this plan to continue.',
    consequence: 'The requested action remains waiting until approval is recorded.',
  },
  rationale: 'test fixture',
};

describe('concierge conversation response boundary', () => {
  it('keeps valid actions, promotion, and intent contract data', () => {
    const parsed = parseConversationMessageResponse({
      reply: 'Plan is ready.',
      mode: 'orchestrator',
      shape: 'execution_preview',
      promoted: { kind: 'mission', label: 'Create mission' },
      nextActions: [{ id: 'confirm', label: 'Proceed' }],
      intentResolution: contract,
    });

    expect(parsed).toMatchObject({
      reply: 'Plan is ready.',
      promoted: { kind: 'mission', label: 'Create mission' },
      nextActions: [{ id: 'confirm', label: 'Proceed' }],
      intentResolution: contract,
    });
  });

  it('drops malformed nested values before they reach the UI', () => {
    const parsed = parseConversationMessageResponse({
      reply: 'Safe reply',
      mode: 'orchestrator',
      shape: 'reply',
      promoted: { kind: 'unknown', label: 'Do not show' },
      nextActions: [
        { id: 'confirm', label: 'Proceed' },
        { id: 'bad', label: 42 },
      ],
      intentResolution: { ...contract, authority_level: 'operator_root' },
    });

    expect(parsed.promoted).toBeUndefined();
    expect(parsed.nextActions).toEqual([{ id: 'confirm', label: 'Proceed' }]);
    expect(parsed.intentResolution).toBeUndefined();
  });

  it('rejects a partial success response without mode and shape', () => {
    expect(parseConversationMessageResponse({ reply: 'untrusted' })).toEqual({
      error: 'The conversation response was invalid.',
    });
  });

  it('does not expose server error text and rejects unsafe response trees', () => {
    const response = JSON.parse(
      '{"reply":" Safe reply ","mode":"orchestrator","shape":"reply","error":"<script>alert(1)</script>"}'
    );
    expect(parseConversationMessageResponse(response)).toEqual({
      reply: 'Safe reply',
      mode: 'orchestrator',
      shape: 'reply',
    });

    const unsafe = JSON.parse(
      '{"reply":"Safe reply","mode":"orchestrator","shape":"reply","nextActions":[{"id":"confirm","label":"Proceed"}],"__proto__":{"polluted":true}}'
    );
    expect(parseConversationMessageResponse(unsafe)).toEqual({
      error: 'The conversation response was invalid.',
    });
  });
});

it('keeps replayed history display-only even if action metadata is supplied', () => {
  expect(
    parseConversationMessageResponse({
      reply: 'Old answer',
      mode: 'history',
      shape: 'execution_preview',
      nextActions: [{ id: 'approve', label: 'Run' }],
      promoted: { kind: 'mission', label: 'old' },
    })
  ).toEqual({ reply: 'Old answer', mode: 'history', shape: 'reply' });
});

it('invalidates only stale-scope conflicts and does not mark proven not-started work pending', () => {
  expect(
    conversationFailurePolicy(409, { error: 'conversation_scope_changed', retry_safe: true })
  ).toMatchObject({ invalidateHistory: true, uncertain: false });
  expect(
    conversationFailurePolicy(409, { error: 'conversation_not_started', retry_safe: true })
  ).toEqual({ invalidateHistory: false, uncertain: false, messageKey: 'conversation_not_started' });
  expect(
    conversationFailurePolicy(422, {
      error: 'conversation_capability_unsupported',
      retry_safe: false,
    })
  ).toMatchObject({
    invalidateHistory: false,
    uncertain: true,
    messageKey: 'conversation_capability_unsupported',
  });
  expect(conversationFailurePolicy(503, {}).uncertain).toBe(true);
});
