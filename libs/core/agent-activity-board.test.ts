import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UNASSIGNED_AGENT_ID,
  composeAgentActivityBoard,
  readMissionTenantSlug,
} from './agent-activity-board.js';
import type { WorkItem } from './work-coordination.js';
import { pathResolver } from './path-resolver.js';
import { safeWriteFile } from './secure-io.js';

function item(partial: Partial<WorkItem>): WorkItem {
  return {
    item_id: 'w1',
    title: 't',
    description: '',
    status: 'ready',
    priority: 'medium',
    source: 'local',
    source_ref: 'r',
    project_id: 'P',
    labels: ['mission:MSN-A'],
    dependencies: [],
    version: 1,
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
    metadata: {},
    ...partial,
  } as WorkItem;
}

describe('agent-activity-board', () => {
  it('maps items to per-agent entries with blockers', () => {
    const board = composeAgentActivityBoard({
      items: [
        item({
          item_id: 'w1',
          assignee_peer_id: 'planner-agent',
          status: 'in_progress',
          metadata: { task_id: 'a', team_role: 'planner', phase: 'intake' },
        }),
        item({
          item_id: 'w2',
          assignee_peer_id: 'impl-agent',
          status: 'ready',
          metadata: { task_id: 'b', dependencies: ['a'], team_role: 'implementer' },
        }),
        item({
          item_id: 'w3',
          status: 'review',
          assignee_peer_id: 'impl-agent',
          metadata: { task_id: 'c' },
        }),
        item({
          item_id: 'w4',
          status: 'blocked',
          assignee_peer_id: 'impl-agent',
          metadata: { task_id: 'd' },
          attempts: [
            {
              attempt_id: 'x',
              run_id: 'run-x',
              status: 'blocked',
              started_at: '2026-07-07T00:00:00Z',
              blocked_reason: 'waiting for operator input',
            },
          ],
        }),
      ],
      tenantByMission: { 'MSN-A': 'aurora' },
      now: '2026-07-07T01:00:00Z',
    });
    expect(board.entries).toHaveLength(4);
    const dep = board.entries.find((entry) => entry.item_id === 'w2');
    // AC-09: the unmet ids are structured data, not embedded in display text.
    expect(dep?.blockers[0]).toMatchObject({ kind: 'dependency', dependency_ids: ['a'] });
    const blocked = board.entries.find((entry) => entry.item_id === 'w4');
    expect(blocked?.blockers[0]).toMatchObject({
      kind: 'blocked',
      blocked_reason: 'waiting for operator input',
    });
    const review = board.entries.find((entry) => entry.item_id === 'w3');
    expect(review?.blockers.some((b) => b.kind === 'review_wait')).toBe(true);
    const impl = board.agents.find((a) => a.agent_id === 'impl-agent');
    expect(impl).toMatchObject({ blocked: 2, in_review: 1 });
    expect(board.entries[0]).toMatchObject({
      tenant_slug: 'aurora',
      project_id: 'P',
      mission_id: 'MSN-A',
    });
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

  it('names an unclaimed work item with the unassigned sentinel and no localized text (AC-09)', () => {
    const board = composeAgentActivityBoard({
      items: [item({ item_id: 'w1', status: 'ready', metadata: { task_id: 'a' } })],
      tenantByMission: { 'MSN-A': 'aurora' },
    });
    expect(board.entries[0]?.agent_id).toBe(UNASSIGNED_AGENT_ID);
    expect(board.agents.map((row) => row.agent_id)).toEqual([UNASSIGNED_AGENT_ID]);
    const blocker = board.entries[0]?.blockers.find((entry) => entry.kind === 'unassigned');
    expect(blocker?.reason).toBe('No agent is assigned to this work item');
    expect(blocker?.dependency_ids).toBeUndefined();
  });

  it('omits blocked_reason when the work item recorded none (AC-09)', () => {
    const board = composeAgentActivityBoard({
      items: [
        item({
          item_id: 'w1',
          status: 'blocked',
          assignee_peer_id: 'impl-agent',
          metadata: { task_id: 'a' },
        }),
      ],
    });
    const blocked = board.entries[0]?.blockers.find((entry) => entry.kind === 'blocked');
    expect(blocked).toMatchObject({ kind: 'blocked' });
    expect(blocked?.blocked_reason).toBeUndefined();
  });

  it('keeps an active work item visible when mission identity is explicit', () => {
    const board = composeAgentActivityBoard({
      items: [
        item({
          item_id: 'explicit-context',
          labels: [],
          context: { mission_id: 'MSN-EXPLICIT', tenant_slug: 'aurora' },
          assignee_peer_id: 'operator-agent',
        }),
      ],
      tenantFilter: 'aurora',
    });
    expect(board.entries[0]).toMatchObject({
      item_id: 'explicit-context',
      mission_id: 'MSN-EXPLICIT',
      tenant_slug: 'aurora',
    });
  });

  it('does not read tenant identity through a symlinked mission directory', () => {
    const missionId = `ACTIVITY-SYMLINK-${process.pid}`;
    const linkedMissionPath = pathResolver.missionDir(missionId, 'public');
    const boundaryRoot = pathResolver.sharedTmp('agent-activity-board-boundary');
    const targetMissionPath = path.join(boundaryRoot, 'target-mission');
    fs.mkdirSync(targetMissionPath, { recursive: true });
    safeWriteFile(
      path.join(targetMissionPath, 'mission-state.json'),
      JSON.stringify({ tenant_slug: 'outside-tenant' })
    );
    fs.mkdirSync(path.dirname(linkedMissionPath), { recursive: true });
    fs.symlinkSync(targetMissionPath, linkedMissionPath, 'dir');

    try {
      expect(readMissionTenantSlug(missionId)).toBeUndefined();
      expect(fs.existsSync(path.join(targetMissionPath, 'mission-state.json'))).toBe(true);
    } finally {
      fs.rmSync(linkedMissionPath, { recursive: true, force: true });
      fs.rmSync(boundaryRoot, { recursive: true, force: true });
    }
  });
});
