import { describe, expect, it } from 'vitest';
import {
  attentionActionForKind,
  buildCollaborationFlowProps,
  buildCollaborationQuery,
  buildCollaborationSequenceProps,
  collaborationNodeStatus,
  collaborationActionLabel,
  collaborationKindLabel,
} from './AgentCollaborationBoard';

describe('AgentCollaborationBoard attention actions (UX-07)', () => {
  it('routes human approval and mission stop/resume actions', () => {
    expect(attentionActionForKind('approval')).toEqual({
      mode: 'view',
      viewId: 'secret-approval-queue',
      label: '承認キューを開く',
    });
    expect(attentionActionForKind('blocked')).toEqual({
      mode: 'mission',
      label: '停止・再開操作を開く',
    });
    expect(attentionActionForKind('waiting')).toEqual({
      mode: 'mission',
      label: '停止・再開操作を開く',
    });
  });

  it('routes operational recovery and handoff inspection', () => {
    expect(attentionActionForKind('retry')).toMatchObject({
      mode: 'view',
      viewId: 'runtime-lease-doctor',
    });
    expect(attentionActionForKind('handoff')).toMatchObject({
      mode: 'view',
      viewId: 'trace-viewer',
    });
    expect(attentionActionForKind('completion')).toBeNull();
  });

  it('keeps collaboration labels aligned with the selected Chronos locale', () => {
    expect(collaborationKindLabel('handoff', 'ja')).toBe('引き継ぎ');
    expect(collaborationKindLabel('handoff', 'en')).toBe('handoff');
    expect(collaborationKindLabel('vendor_specific_event', 'en')).toBe('vendor_specific_event');
    expect(collaborationActionLabel('approval', 'ja')).toBe('承認キューを開く');
    expect(collaborationActionLabel('approval', 'en')).toBe('Open approval queue');
    expect(collaborationActionLabel('completion', 'en')).toBeNull();
  });

  it('builds a scoped collaboration query without leaking empty filters', () => {
    expect(buildCollaborationQuery('client a', 'MSN-42')).toBe('?tenant=client+a&mission=MSN-42');
    expect(buildCollaborationQuery('', '')).toBe('');
  });
});

describe('AgentCollaborationBoard diagrams (UI-07 wave 3b)', () => {
  const node = (
    id: string,
    type: 'mission' | 'task' | 'agent',
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    type,
    label: id,
    waiting_on: [],
    handoffs: [],
    children: [],
    ...extra,
  });

  it('maps node state and open waits onto canonical statuses', () => {
    expect(collaborationNodeStatus({ state: 'running', waiting_on: [] })).toBe('working');
    expect(collaborationNodeStatus({ state: 'completed', waiting_on: [] })).toBe('done');
    expect(
      collaborationNodeStatus({
        state: 'running',
        waiting_on: [{ reason: 'blocked', since: 't' }],
      })
    ).toBe('blocked');
    expect(collaborationNodeStatus({ state: 'weird', waiting_on: [] })).toBeUndefined();
  });

  it('builds a staged ui:flow with parent → child edges', () => {
    const agent = node('agent:impl', 'agent', { state: 'running' });
    const task = node('task:1', 'task', { children: [agent] });
    const mission = node('mission:M', 'mission', { children: [task] });
    const flow = buildCollaborationFlowProps(
      [mission, task, agent].map((n) => ({ node: n as never })),
      'en'
    );
    expect(flow.nodes.map((n) => n.stage)).toEqual(['mission', 'task', 'agent']);
    expect(flow.edges).toEqual([
      { from: 'mission:M', to: 'task:1' },
      { from: 'task:1', to: 'agent:impl' },
    ]);
    expect(flow.nodes[2].status).toBe('working');
  });

  it('builds a time-ordered ui:sequence from handoff edges', () => {
    const sequence = buildCollaborationSequenceProps(
      {
        edges: [
          { from: 'agent:b', to: 'agent:c', kind: 'handoff', event_id: 'e2' },
          { from: 'agent:a', to: 'agent:b', kind: 'dispatch', event_id: 'e1' },
        ],
        events: [
          {
            event_id: 'e1',
            ts: '2026-09-23T10:00:00Z',
            kind: 'dispatch',
            summary: '',
            source: 's',
          },
          { event_id: 'e2', ts: '2026-09-23T10:05:00Z', kind: 'handoff', summary: '', source: 's' },
        ],
      },
      'ja'
    );
    expect(sequence.participants).toEqual([
      { id: 'agent:a', label: 'a' },
      { id: 'agent:b', label: 'b' },
      { id: 'agent:c', label: 'c' },
    ]);
    expect(sequence.messages[0]).toMatchObject({
      from: 'agent:a',
      at: '10:00:00',
      status: 'working',
    });
    expect(sequence.messages[1]).toMatchObject({ label: '引き継ぎ' });
  });
});
