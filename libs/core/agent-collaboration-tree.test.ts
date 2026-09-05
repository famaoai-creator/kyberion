import { describe, expect, it } from 'vitest';
import type { AgentActivityBoard } from './agent-activity-board.js';
import { composeAgentCollaborationProjection } from './agent-collaboration-projection.js';
import { createAgentCollaborationEvent } from './agent-collaboration-events.js';
import {
  composeCollaborationTree,
  flattenCollaborationTree,
  type CollaborationTree,
  type CollaborationTreeNode,
} from './agent-collaboration-tree.js';

const NOW = '2026-09-06T01:00:00.000Z';

/**
 * Same shape as `agent-collaboration-projection.test.ts`'s helper, with an
 * explicit `event_id` so the projection's `ts` tie-breaks are deterministic
 * (the default id is a random UUID).
 */
function event(partial: Partial<Parameters<typeof createAgentCollaborationEvent>[0]>) {
  const sourceEventId = partial.source_event_id || 'source-1';
  return createAgentCollaborationEvent({
    event_id: partial.event_id || `EV-${sourceEventId}`,
    source_event_id: sourceEventId,
    ts: partial.ts || '2026-09-06T00:00:00.000Z',
    seq: partial.seq || 0,
    actor_type: partial.actor_type || 'agent',
    kind: partial.kind || 'progress',
    summary: partial.summary || 'progress',
    redaction: partial.redaction || 'summary',
    source: partial.source || 'task',
    ...partial,
  });
}

/**
 * One mission, two tasks, a running spawn child, a finished spawn child, an
 * open and an answered approval, an a2a handoff, an orphan agent, a stale
 * agent and a spawn cycle.
 */
function fixtureEvents() {
  return [
    event({
      source_event_id: 'dispatch-planner',
      kind: 'dispatch',
      mission_id: 'MSN-TREE',
      task_id: 'T-1',
      agent_id: 'planner',
      state_after: 'running',
      provider: 'claude-cli',
      team_role: 'orchestrator',
      ts: '2026-09-06T00:50:00.000Z',
    }),
    event({
      source_event_id: 'progress-planner',
      kind: 'progress',
      mission_id: 'MSN-TREE',
      task_id: 'T-1',
      agent_id: 'planner',
      state_after: 'running',
      ts: '2026-09-06T00:59:00.000Z',
    }),
    event({
      source_event_id: 'dispatch-writer',
      kind: 'dispatch',
      mission_id: 'MSN-TREE',
      task_id: 'T-2',
      agent_id: 'writer',
      state_after: 'running',
      ts: '2026-09-06T00:51:00.000Z',
    }),
    // running child: no matching end for DEL-1
    event({
      source_event_id: 'spawn-impl-a',
      kind: 'spawn',
      mission_id: 'MSN-TREE',
      task_id: 'T-1',
      agent_id: 'impl-a',
      parent_agent_id: 'planner',
      delegation_id: 'DEL-1',
      team_role: 'implementer',
      provider: 'codex',
      native: true,
      ts: '2026-09-06T00:57:00.000Z',
    }),
    // finished child: DEL-2 ends at 00:55
    event({
      source_event_id: 'spawn-impl-b',
      kind: 'spawn',
      mission_id: 'MSN-TREE',
      task_id: 'T-2',
      agent_id: 'impl-b',
      parent_agent_id: 'writer',
      delegation_id: 'DEL-2',
      ts: '2026-09-06T00:53:00.000Z',
    }),
    event({
      source_event_id: 'end-impl-b',
      kind: 'completion',
      mission_id: 'MSN-TREE',
      task_id: 'T-2',
      agent_id: 'impl-b',
      delegation_id: 'DEL-2',
      state_after: 'success',
      elapsed_ms: 120000,
      ts: '2026-09-06T00:55:00.000Z',
    }),
    // open approval (REQ-1) and an answered one (REQ-2)
    event({
      source_event_id: 'approval-open',
      kind: 'approval',
      mission_id: 'MSN-TREE',
      task_id: 'T-2',
      agent_id: 'gatekeeper',
      request_id: 'REQ-1',
      channel: 'slack',
      state_after: 'pending',
      ts: '2026-09-06T00:56:00.000Z',
    }),
    event({
      source_event_id: 'approval-asked',
      kind: 'approval',
      mission_id: 'MSN-TREE',
      agent_id: 'gatekeeper',
      request_id: 'REQ-2',
      state_after: 'pending',
      ts: '2026-09-06T00:54:00.000Z',
    }),
    event({
      source_event_id: 'approval-answered',
      kind: 'approval',
      mission_id: 'MSN-TREE',
      agent_id: 'operator',
      actor_type: 'human',
      request_id: 'REQ-2',
      state_after: 'approved',
      ts: '2026-09-06T00:54:30.000Z',
    }),
    event({
      source_event_id: 'handoff-1',
      kind: 'handoff',
      mission_id: 'MSN-TREE',
      agent_id: 'writer',
      sender: 'planner',
      receiver: 'writer',
      performative: 'request',
      ts: '2026-09-06T00:58:00.000Z',
    }),
    event({
      source_event_id: 'orphan-1',
      kind: 'progress',
      agent_id: 'lonely-scout',
      state_after: 'running',
      ts: '2026-09-06T00:58:00.000Z',
    }),
    event({
      source_event_id: 'stale-1',
      kind: 'progress',
      mission_id: 'MSN-TREE',
      task_id: 'T-1',
      agent_id: 'stale-worker',
      state_after: 'running',
      ts: '2026-09-06T00:10:00.000Z',
    }),
    // spawn cycle: cyc-a spawns cyc-b, cyc-b spawns cyc-a
    event({
      source_event_id: 'cycle-1',
      kind: 'spawn',
      mission_id: 'MSN-TREE',
      agent_id: 'cyc-b',
      parent_agent_id: 'cyc-a',
      delegation_id: 'DEL-3',
      ts: '2026-09-06T00:58:00.000Z',
    }),
    event({
      source_event_id: 'cycle-2',
      kind: 'spawn',
      mission_id: 'MSN-TREE',
      agent_id: 'cyc-a',
      parent_agent_id: 'cyc-b',
      delegation_id: 'DEL-4',
      ts: '2026-09-06T00:59:00.000Z',
    }),
  ];
}

function buildFixtureTree(): CollaborationTree {
  return composeCollaborationTree(
    composeAgentCollaborationProjection(fixtureEvents(), { now: NOW }),
    { now: NOW }
  );
}

function findNode(tree: CollaborationTree, id: string): CollaborationTreeNode {
  const row = flattenCollaborationTree(tree).find((entry) => entry.node.id === id);
  if (!row) throw new Error(`node ${id} missing from tree`);
  return row.node;
}

describe('collaboration tree (AC-04)', () => {
  it('nests mission -> task -> agent -> spawned child in a deterministic pre-order', () => {
    const tree = buildFixtureTree();

    expect(flattenCollaborationTree(tree).map((entry) => [entry.depth, entry.node.id])).toEqual([
      [0, 'mission:MSN-TREE'],
      [1, 'task:T-1'],
      [2, 'agent:stale-worker'],
      [2, 'agent:planner'],
      [3, 'agent:impl-a'],
      [1, 'task:T-2'],
      [2, 'agent:writer'],
      [3, 'agent:impl-b'],
      [2, 'agent:gatekeeper'],
      [1, 'agent:cyc-b'],
      [2, 'agent:cyc-a'],
      [0, 'agent:lonely-scout'],
    ]);
    expect(tree.generated_at).toBe(NOW);
  });

  it('carries provider, team_role and native from the delegation event onto the child node', () => {
    const child = findNode(buildFixtureTree(), 'agent:impl-a');

    expect(child).toMatchObject({
      type: 'agent',
      label: 'impl-a',
      state: 'running',
      provider: 'codex',
      team_role: 'implementer',
      native: true,
      started_at: '2026-09-06T00:57:00.000Z',
    });
  });

  it('measures a running child against now and a finished child against its end event', () => {
    const tree = buildFixtureTree();

    // 00:57 -> now (01:00)
    expect(findNode(tree, 'agent:impl-a').elapsed_ms).toBe(180000);
    // 00:53 -> subagent_end at 00:55, not now
    expect(findNode(tree, 'agent:impl-b')).toMatchObject({
      state: 'success',
      elapsed_ms: 120000,
      last_event_at: '2026-09-06T00:55:00.000Z',
    });
  });

  it('marks the parent of a running child, but not of a finished one', () => {
    const tree = buildFixtureTree();

    expect(findNode(tree, 'agent:planner').waiting_on).toEqual([
      { reason: 'child_running', target_id: 'agent:impl-a', since: '2026-09-06T00:57:00.000Z' },
    ]);
    expect(findNode(tree, 'agent:writer').waiting_on).toEqual([]);
  });

  it('keeps an unanswered approval open on the agent and the mission, and closes an answered one', () => {
    const tree = buildFixtureTree();
    const openWait = {
      reason: 'approval_pending',
      target_id: 'human:slack',
      since: '2026-09-06T00:56:00.000Z',
    };

    expect(findNode(tree, 'agent:gatekeeper').waiting_on).toEqual([openWait]);
    expect(findNode(tree, 'mission:MSN-TREE').waiting_on).toEqual([openWait]);
    // REQ-2 was answered at 00:54:30, so only REQ-1 is still waiting on a human.
    expect(tree.stats.humans_waited_on).toBe(1);
  });

  it('records the a2a handoff on the sender', () => {
    const tree = buildFixtureTree();

    expect(findNode(tree, 'agent:planner').handoffs).toEqual([
      { to_agent_id: 'agent:writer', performative: 'request', at: '2026-09-06T00:58:00.000Z' },
    ]);
    expect(findNode(tree, 'agent:writer').handoffs).toEqual([]);
  });

  it('puts an agent with no mission attribution into orphans', () => {
    const tree = buildFixtureTree();

    expect(tree.orphans.map((node) => node.id)).toEqual(['agent:lonely-scout']);
    expect(tree.roots.map((node) => node.id)).toEqual(['mission:MSN-TREE']);
  });

  it('flags a running node whose last event is older than staleAfterMs', () => {
    const tree = buildFixtureTree();

    expect(findNode(tree, 'agent:stale-worker').waiting_on).toEqual([
      { reason: 'stale', since: '2026-09-06T00:10:00.000Z' },
    ]);
    // A generous stale window clears it without changing anything else.
    const relaxed = composeCollaborationTree(
      composeAgentCollaborationProjection(fixtureEvents(), { now: NOW }),
      { now: NOW, staleAfterMs: 24 * 60 * 60 * 1000 }
    );
    expect(findNode(relaxed, 'agent:stale-worker').waiting_on).toEqual([]);
  });

  it('terminates on a spawn cycle by keeping only the forward edge', () => {
    const tree = buildFixtureTree();
    const cycB = findNode(tree, 'agent:cyc-b');

    expect(cycB.children.map((node) => node.id)).toEqual(['agent:cyc-a']);
    expect(cycB.children[0].children).toEqual([]);
    expect(cycB.waiting_on).toEqual([
      { reason: 'child_running', target_id: 'agent:cyc-a', since: '2026-09-06T00:59:00.000Z' },
    ]);
    // The cycle's entry agent has no task, so it hangs off the mission itself.
    expect(tree.roots[0].children.map((node) => node.id)).toEqual([
      'task:T-1',
      'task:T-2',
      'agent:cyc-b',
    ]);
  });

  it('flattens every wait into one since-ascending list and counts the stats', () => {
    const tree = buildFixtureTree();

    expect(tree.waiting).toEqual([
      { node_id: 'agent:stale-worker', reason: 'stale', since: '2026-09-06T00:10:00.000Z' },
      {
        node_id: 'agent:gatekeeper',
        reason: 'approval_pending',
        since: '2026-09-06T00:56:00.000Z',
        target_id: 'human:slack',
      },
      {
        node_id: 'mission:MSN-TREE',
        reason: 'approval_pending',
        since: '2026-09-06T00:56:00.000Z',
        target_id: 'human:slack',
      },
      {
        node_id: 'agent:planner',
        reason: 'child_running',
        since: '2026-09-06T00:57:00.000Z',
        target_id: 'agent:impl-a',
      },
      {
        node_id: 'agent:cyc-b',
        reason: 'child_running',
        since: '2026-09-06T00:59:00.000Z',
        target_id: 'agent:cyc-a',
      },
    ]);
    expect(tree.stats).toEqual({
      missions: 1,
      tasks: 2,
      agents_total: 9,
      agents_running: 7,
      agents_waiting: 4,
      agents_done: 1,
      humans_waited_on: 1,
    });
  });

  it('produces deep-equal output across runs for identical input', () => {
    const events = fixtureEvents();
    const first = composeCollaborationTree(
      composeAgentCollaborationProjection(events, { now: NOW }),
      { now: NOW }
    );
    const second = composeCollaborationTree(
      composeAgentCollaborationProjection(events, { now: NOW }),
      { now: NOW }
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('falls back to the projection clock when no now is given', () => {
    const projection = composeAgentCollaborationProjection(fixtureEvents(), { now: NOW });

    expect(composeCollaborationTree(projection).generated_at).toBe(NOW);
  });

  it('derives blocked / review_pending from unresolved projection events', () => {
    const tree = composeCollaborationTree(
      composeAgentCollaborationProjection(
        [
          event({
            source_event_id: 'b-1',
            kind: 'blocked',
            mission_id: 'MSN-B',
            task_id: 'T-B',
            agent_id: 'stuck',
            ts: '2026-09-06T00:58:00.000Z',
          }),
          event({
            source_event_id: 'r-1',
            kind: 'review',
            mission_id: 'MSN-B',
            task_id: 'T-B',
            agent_id: 'awaiting-review',
            ts: '2026-09-06T00:57:00.000Z',
          }),
          // resolved: review followed by a completion on the same agent
          event({
            source_event_id: 'r-2',
            kind: 'review',
            mission_id: 'MSN-B',
            task_id: 'T-B',
            agent_id: 'reviewed',
            ts: '2026-09-06T00:57:00.000Z',
          }),
          event({
            source_event_id: 'r-3',
            kind: 'completion',
            mission_id: 'MSN-B',
            task_id: 'T-B',
            agent_id: 'reviewed',
            state_after: 'done',
            ts: '2026-09-06T00:59:00.000Z',
          }),
        ],
        { now: NOW }
      ),
      { now: NOW }
    );

    expect(findNode(tree, 'agent:stuck').waiting_on).toEqual([
      { reason: 'blocked', since: '2026-09-06T00:58:00.000Z' },
    ]);
    expect(findNode(tree, 'agent:awaiting-review').waiting_on).toEqual([
      { reason: 'review_pending', since: '2026-09-06T00:57:00.000Z' },
    ]);
    expect(findNode(tree, 'agent:reviewed').waiting_on).toEqual([]);
  });

  it('maps activity-board blockers onto the deepest known node', () => {
    const projection = composeAgentCollaborationProjection(
      [
        event({
          source_event_id: 'board-dispatch',
          kind: 'dispatch',
          mission_id: 'MSN-BOARD',
          task_id: 'T-9',
          agent_id: 'coder',
          state_after: 'running',
          ts: '2026-09-06T00:59:00.000Z',
        }),
      ],
      { now: NOW }
    );
    const activityBoard: AgentActivityBoard = {
      generated_at: NOW,
      entries: [
        {
          agent_id: 'coder',
          mission_id: 'MSN-BOARD',
          task_id: 'T-9',
          item_id: 'WI-1',
          title: 'blocked item',
          status: 'blocked',
          blockers: [{ kind: 'blocked', reason: 'needs input' }],
          updated_at: '2026-09-06T00:40:00.000Z',
        },
        {
          agent_id: 'coder',
          mission_id: 'MSN-BOARD',
          task_id: 'T-9',
          item_id: 'WI-2',
          title: 'review item',
          status: 'review',
          blockers: [{ kind: 'review_wait', reason: 'gate' }],
          updated_at: '2026-09-06T00:45:00.000Z',
        },
        {
          // Neither the agent nor the task exists in the projection, so this
          // falls back to the mission node.
          agent_id: '(unassigned)',
          mission_id: 'MSN-BOARD',
          task_id: 'T-77',
          item_id: 'WI-3',
          title: 'unclaimed item',
          status: 'ready',
          blockers: [{ kind: 'unassigned', reason: 'no assignee' }],
          updated_at: '2026-09-06T00:46:00.000Z',
        },
        {
          agent_id: 'coder',
          mission_id: 'MSN-BOARD',
          task_id: 'T-9',
          item_id: 'WI-4',
          title: 'dependency item',
          status: 'ready',
          blockers: [{ kind: 'dependency', reason: 'waits on T-8' }],
          updated_at: '2026-09-06T00:47:00.000Z',
        },
      ],
      agents: [],
    };

    const tree = composeCollaborationTree(projection, { now: NOW, activityBoard });

    expect(findNode(tree, 'agent:coder').waiting_on).toEqual([
      { reason: 'blocked', target_id: 'work-item:WI-1', since: '2026-09-06T00:40:00.000Z' },
      { reason: 'review_pending', target_id: 'work-item:WI-2', since: '2026-09-06T00:45:00.000Z' },
      { reason: 'blocked', target_id: 'work-item:WI-4', since: '2026-09-06T00:47:00.000Z' },
    ]);
    expect(findNode(tree, 'mission:MSN-BOARD').waiting_on).toEqual([
      { reason: 'claim_pending', target_id: 'work-item:WI-3', since: '2026-09-06T00:46:00.000Z' },
    ]);
    expect(tree.waiting.map((entry) => entry.reason)).toEqual([
      'blocked',
      'review_pending',
      'claim_pending',
      'blocked',
    ]);
    expect(tree.stats).toMatchObject({ agents_waiting: 1, humans_waited_on: 0 });
  });

  it('returns an empty tree for an empty projection', () => {
    const tree = composeCollaborationTree(composeAgentCollaborationProjection([], { now: NOW }), {
      now: NOW,
    });

    expect(tree.roots).toEqual([]);
    expect(tree.orphans).toEqual([]);
    expect(tree.waiting).toEqual([]);
    expect(tree.stats).toEqual({
      missions: 0,
      tasks: 0,
      agents_total: 0,
      agents_running: 0,
      agents_waiting: 0,
      agents_done: 0,
      humans_waited_on: 0,
    });
    expect(flattenCollaborationTree(tree)).toEqual([]);
  });
});
