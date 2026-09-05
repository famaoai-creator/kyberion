import { describe, expect, it } from 'vitest';
import { parseCollaborationResponse } from './collaboration-response';

const projection = {
  revision: 42,
  generated_at: '2026-09-04T00:00:00.000Z',
  partial: false,
  status_flags: ['stale_runtime'],
  sequence_gaps: [{ source: 'runtime', previous_seq: 1, expected_seq: 2, actual_seq: 3 }],
  overview: {
    events: 1,
    missions: 1,
    tasks: 1,
    agents: 1,
    active: 1,
    blocked: 0,
    waiting_human: 0,
    review_pending: 0,
    failures: 0,
    native_subagents: 1,
    unavailable_subagents: 0,
  },
  events: [
    {
      event_id: 'event-1',
      ts: '2026-09-04T00:00:00.000Z',
      kind: 'handoff',
      summary: 'handoff recorded',
      source: 'runtime',
      evidence_refs: ['trace-1'],
      native: true,
      effort: 'medium',
    },
  ],
  edges: [{ from: 'agent-a', to: 'agent-b', kind: 'handoff', event_id: 'event-1' }],
  attention: [
    {
      event_id: 'event-1',
      kind: 'handoff',
      title: 'Review handoff',
      reason: 'review is pending',
      next_action: 'open trace',
      mission_id: 'MSN-1',
    },
  ],
  tree: {
    generated_at: '2026-09-04T00:00:00.000Z',
    roots: [
      {
        id: 'mission:MSN-1',
        type: 'mission',
        label: 'MSN-1',
        last_event_at: '2026-09-04T00:00:00.000Z',
        waiting_on: [],
        handoffs: [],
        children: [
          {
            id: 'agent:agent-a',
            type: 'agent',
            label: 'agent-a',
            state: 'running',
            provider: 'claude-cli',
            team_role: 'implementer',
            elapsed_ms: 4200,
            waiting_on: [{ reason: 'approval_pending', since: '2026-09-04T00:00:00.000Z' }],
            handoffs: [
              {
                to_agent_id: 'agent:agent-b',
                performative: 'inform',
                at: '2026-09-04T00:00:00.000Z',
              },
            ],
            children: [],
          },
        ],
      },
    ],
    orphans: [],
    waiting: [
      { node_id: 'agent:agent-a', reason: 'approval_pending', since: '2026-09-04T00:00:00.000Z' },
    ],
    stats: {
      missions: 1,
      tasks: 0,
      agents_total: 1,
      agents_running: 1,
      agents_waiting: 1,
      agents_done: 0,
      humans_waited_on: 1,
    },
  },
};

describe('collaboration response boundary', () => {
  it('accepts the projection fields consumed by the collaboration board', () => {
    expect(parseCollaborationResponse({ ok: true, projection })).toEqual(projection);
  });

  it('rejects an unsuccessful or incomplete response before state update', () => {
    expect(parseCollaborationResponse({ ok: false, projection })).toBeUndefined();
    expect(
      parseCollaborationResponse({
        ok: true,
        projection: { ...projection, overview: { ...projection.overview, failures: '0' } },
      })
    ).toBeUndefined();
  });

  it('rejects unsafe nested keys and invalid enum values', () => {
    const unsafe = JSON.parse(
      '{"event_id":"event-1","ts":"2026-09-04T00:00:00.000Z","kind":"handoff","summary":"handoff recorded","source":"runtime","__proto__":"bad"}'
    );
    expect(
      parseCollaborationResponse({ ok: true, projection: { ...projection, events: [unsafe] } })
    ).toBeUndefined();
    expect(
      parseCollaborationResponse({
        ok: true,
        projection: { ...projection, status_flags: ['unexpected'] },
      })
    ).toBeUndefined();
    expect(
      parseCollaborationResponse({
        ok: true,
        projection: { ...projection, events: [{ ...projection.events[0], effort: 'extreme' }] },
      })
    ).toBeUndefined();
  });

  it('rejects a missing tree and an invalid wait reason nested inside it (AC-06)', () => {
    const { tree: _omitted, ...projectionWithoutTree } = projection;
    expect(
      parseCollaborationResponse({ ok: true, projection: projectionWithoutTree })
    ).toBeUndefined();
    const invalidWaitReason = {
      ...projection.tree,
      roots: [
        {
          ...projection.tree.roots[0],
          children: [
            {
              ...projection.tree.roots[0].children[0],
              waiting_on: [{ reason: 'unexpected', since: '2026-09-04T00:00:00.000Z' }],
            },
          ],
        },
      ],
    };
    expect(
      parseCollaborationResponse({
        ok: true,
        projection: { ...projection, tree: invalidWaitReason },
      })
    ).toBeUndefined();
  });
});
