import { describe, expect, it } from 'vitest';
import {
  emitMissionTaskEvent,
  parseMissionTaskEventIdentity,
  redactMissionTaskEventForShared,
} from './mission-task-events.js';
import { redactCollaborationMetadata } from './agent-collaboration-events.js';
import { normalizeEventScope } from './event-scope.js';

describe('mission task event scope lineage', () => {
  it('parses only task-event identity rows and rejects unrelated mission data', () => {
    expect(
      parseMissionTaskEventIdentity({
        event_type: 'task_completed',
        mission_id: 'MSN-1',
        task_id: 'TASK-1',
      })
    ).toEqual({ event_type: 'task_completed', mission_id: 'MSN-1', task_id: 'TASK-1' });
    expect(parseMissionTaskEventIdentity([])).toBeUndefined();
    expect(
      parseMissionTaskEventIdentity({
        event_type: 'unknown',
        mission_id: 'MSN-1',
        task_id: 'TASK-1',
      })
    ).toBeUndefined();
    expect(
      parseMissionTaskEventIdentity({
        event_type: 'task_completed',
        mission_id: 'MSN-1',
        task_id: '',
      })
    ).toBeUndefined();
  });

  it('rejects a caller-supplied tenant that is not authoritative for the mission', () => {
    expect(() =>
      emitMissionTaskEvent({
        event_type: 'task_issued',
        mission_id: `MSN-TASK-SCOPE-CONFLICT-${process.pid}`,
        task_id: 'TASK-1',
        decision: 'dispatch',
        why: 'test',
        policy_used: 'test',
        scope: { tier: 'confidential', tenant_slug: 'other-tenant' },
      })
    ).toThrow(/EVENT_SCOPE_LINEAGE_CONFLICT/);
  });

  it('does not project task payloads into the shared event shape', () => {
    const shared = redactMissionTaskEventForShared({
      ts: '2026-08-15T00:00:00.000Z',
      event_id: 'TASK-EVENT-1',
      event_type: 'task_completed',
      mission_id: 'MSN-SHARED-1',
      task_id: 'TASK-1',
      decision: 'completed',
      why: 'done',
      policy_used: 'test',
      evidence: ['secret response: token=should-not-cross'],
      payload: { task_result: { confidential: 'must-not-leak' } },
      scope: normalizeEventScope({
        tier: 'confidential',
        tenant_slug: 'client-a',
        mission_id: 'MSN-SHARED-1',
        task_id: 'TASK-1',
        nhi_id: 'kyberion://agent/client-a/worker',
      }),
    });

    expect(shared.payload).toBeUndefined();
    expect(JSON.stringify(shared)).not.toContain('must-not-leak');
    expect(JSON.stringify(shared)).not.toContain('should-not-cross');
    expect((shared.scope as Record<string, unknown>).nhi_id).toBeUndefined();
  });

  it('keeps shared collaboration metadata scalar and allowlisted', () => {
    const redacted = redactCollaborationMetadata({
      decision: 'completed',
      why: 'safe summary',
      mission_id: 'MSN-1',
      sourceText: 'must not cross the shared boundary',
      response: 'must not cross the shared boundary',
      nested: { secret: 'must not cross the shared boundary' },
    });

    expect(redacted).toMatchObject({ decision: 'completed', mission_id: 'MSN-1' });
    expect(redacted.sourceText).toBeUndefined();
    expect(redacted.response).toBeUndefined();
    expect(redacted.nested).toBeUndefined();
  });

  it('keeps only the redacted scope envelope in shared metadata', () => {
    const redacted = redactCollaborationMetadata({
      scope: normalizeEventScope({
        tier: 'confidential',
        tenant_slug: 'client-a',
        mission_id: 'MSN-1',
        viewer_principal: 'human:alice',
        nhi_id: 'kyberion://agent/client-a/worker',
      }),
    });

    expect(redacted.scope).toMatchObject({ tenant_slug: 'client-a', mission_id: 'MSN-1' });
    expect((redacted.scope as Record<string, unknown>).viewer_principal).toBeUndefined();
    expect((redacted.scope as Record<string, unknown>).nhi_id).toBeUndefined();
  });
});
