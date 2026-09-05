import { describe, expect, it } from 'vitest';
import {
  createAgentCollaborationEvent,
  redactCollaborationMetadata,
} from './agent-collaboration-events.js';

describe('agent collaboration events (AC-02)', () => {
  it('keeps a2a and delegation correlation keys through shared metadata redaction', () => {
    const redacted = redactCollaborationMetadata({
      sender: 'agent:planner',
      receiver: 'agent:worker-1',
      performative: 'request',
      intent: 'delegate_task',
      delegation_id: 'DEL-123',
      parent_agent_id: 'agent:planner',
      instruction_summary: 'implement AC-02 edges',
      elapsed_ms: 4210,
    });

    expect(redacted).toMatchObject({
      sender: 'agent:planner',
      receiver: 'agent:worker-1',
      performative: 'request',
      intent: 'delegate_task',
      delegation_id: 'DEL-123',
      parent_agent_id: 'agent:planner',
      instruction_summary: 'implement AC-02 edges',
      elapsed_ms: 4210,
    });
    // elapsed_ms must survive as a number, not be coerced to a string.
    expect(typeof redacted.elapsed_ms).toBe('number');
  });

  it('drops body-fragment fields even when placed alongside allowlisted keys', () => {
    const redacted = redactCollaborationMetadata({
      sender: 'agent:planner',
      receiver: 'agent:worker-1',
      prompt_excerpt: 'must not cross the shared boundary',
      thread: 'must not cross the shared boundary',
    });

    expect(redacted.sender).toBe('agent:planner');
    expect(redacted.receiver).toBe('agent:worker-1');
    expect(redacted.prompt_excerpt).toBeUndefined();
    expect(redacted.thread).toBeUndefined();
  });

  it('constructs a collaboration event carrying the new a2a and delegation fields', () => {
    const event = createAgentCollaborationEvent({
      source_event_id: 'a2a-1',
      ts: '2026-09-06T00:00:00.000Z',
      seq: 1,
      actor_type: 'agent',
      kind: 'handoff',
      summary: 'routed message',
      redaction: 'summary',
      source: 'orchestration',
      sender: 'agent:planner',
      receiver: 'agent:worker-1',
      performative: 'request',
      delegation_id: 'DEL-123',
      parent_agent_id: 'agent:planner',
      team_role: 'implementer',
      instruction_summary: 'implement AC-02 edges',
      elapsed_ms: 4210,
    });

    expect(event).toMatchObject({
      sender: 'agent:planner',
      receiver: 'agent:worker-1',
      performative: 'request',
      delegation_id: 'DEL-123',
      parent_agent_id: 'agent:planner',
      team_role: 'implementer',
      instruction_summary: 'implement AC-02 edges',
      elapsed_ms: 4210,
    });
  });
});
