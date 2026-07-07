import { describe, expect, it } from 'vitest';
import { composeAgentActivityBoard } from './agent-activity-board.js';
import type { WorkItem } from './work-coordination.js';

function item(partial: Partial<WorkItem>): WorkItem {
  return {
    item_id: 'w1', title: 't', description: '', status: 'ready', priority: 'medium',
    source: 'local', source_ref: 'r', project_id: 'P', labels: ['mission:MSN-A'],
    dependencies: [], version: 1, created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z', metadata: {},
    ...partial,
  } as WorkItem;
}

describe('agent-activity-board', () => {
  it('maps items to per-agent entries with blockers', () => {
    const board = composeAgentActivityBoard({
      items: [
        item({ item_id: 'w1', assignee_peer_id: 'planner-agent', status: 'in_progress',
          metadata: { task_id: 'a', team_role: 'planner', phase: 'intake' } }),
        item({ item_id: 'w2', assignee_peer_id: 'impl-agent', status: 'ready',
          metadata: { task_id: 'b', dependencies: ['a'], team_role: 'implementer' } }),
        item({ item_id: 'w3', status: 'review', assignee_peer_id: 'impl-agent',
          metadata: { task_id: 'c' } }),
        item({ item_id: 'w4', status: 'blocked', assignee_peer_id: 'impl-agent',
          metadata: { task_id: 'd' }, attempts: [{ attempt_id: 'x', status: 'blocked', note: '入力待ち' } as never] }),
      ],
      tenantByMission: { 'MSN-A': 'aurora' },
      now: '2026-07-07T01:00:00Z',
    });
    expect(board.entries).toHaveLength(4);
    const dep = board.entries.find((entry) => entry.item_id === 'w2');
    expect(dep?.blockers[0]).toMatchObject({ kind: 'dependency' });
    const blocked = board.entries.find((entry) => entry.item_id === 'w4');
    expect(blocked?.blockers[0]).toMatchObject({ kind: 'blocked', reason: '入力待ち' });
    const review = board.entries.find((entry) => entry.item_id === 'w3');
    expect(review?.blockers.some((b) => b.kind === 'review_wait')).toBe(true);
    const impl = board.agents.find((a) => a.agent_id === 'impl-agent');
    expect(impl).toMatchObject({ blocked: 2, in_review: 1 });
    expect(board.entries[0]?.tenant_slug).toBe('aurora');
  });

  it('filters by tenant and hides done items', () => {
    const board = composeAgentActivityBoard({
      items: [
        item({ item_id: 'w1', labels: ['mission:MSN-A'] }),
        item({ item_id: 'w2', labels: ['mission:MSN-B'] }),
        item({ item_id: 'w3', labels: ['mission:MSN-A'], status: 'done' }),
      ],
      tenantByMission: { 'MSN-A': 'aurora', 'MSN-B': 'other' },
      tenantFilter: 'aurora',
    });
    expect(board.entries.map((entry) => entry.item_id)).toEqual(['w1']);
  });
});
