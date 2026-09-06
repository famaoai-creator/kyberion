import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  buildAgentCollaborationProjection,
  composeAgentCollaborationProjection,
} from './agent-collaboration-projection.js';
import { createAgentCollaborationEvent } from './agent-collaboration-events.js';

function event(partial: Partial<Parameters<typeof createAgentCollaborationEvent>[0]>) {
  return createAgentCollaborationEvent({
    source_event_id: partial.source_event_id || 'source-1',
    ts: partial.ts || '2026-07-26T00:00:00.000Z',
    seq: partial.seq || 0,
    actor_type: partial.actor_type || 'agent',
    kind: partial.kind || 'progress',
    summary: partial.summary || 'progress',
    redaction: partial.redaction || 'summary',
    source: partial.source || 'task',
    ...partial,
  });
}

describe('agent collaboration projection', () => {
  it('builds overview, graph, timeline and attention from a shared event shape', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source_event_id: 'dispatch-1',
        kind: 'dispatch',
        mission_id: 'MSN-A',
        task_id: 'T-1',
        agent_id: 'planner',
      }),
      event({
        source_event_id: 'blocked-1',
        kind: 'blocked',
        mission_id: 'MSN-A',
        task_id: 'T-1',
        agent_id: 'planner',
        summary: '依存タスク待ち',
      }),
      event({
        source_event_id: 'review-1',
        kind: 'review',
        mission_id: 'MSN-A',
        task_id: 'T-1',
        agent_id: 'reviewer',
        summary: '成果物レビュー待ち',
      }),
    ]);

    expect(projection.overview).toMatchObject({
      events: 3,
      missions: 1,
      tasks: 1,
      agents: 2,
      blocked: 1,
      review_pending: 1,
    });
    expect(projection.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mission:MSN-A', type: 'mission' }),
        expect.objectContaining({ id: 'task:T-1', type: 'task' }),
        expect.objectContaining({ id: 'agent:planner', type: 'agent' }),
      ])
    );
    expect(projection.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'mission:MSN-A', to: 'task:T-1' }),
        expect.objectContaining({ from: 'task:T-1', to: 'agent:planner' }),
      ])
    );
    expect(projection.attention.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['review', 'blocked'])
    );
  });

  it('deduplicates source events, filters missions and redacts sensitive summaries', () => {
    const duplicate = event({
      source_event_id: 'same',
      mission_id: 'MSN-A',
      summary: 'token=secret-value',
    });
    const projection = composeAgentCollaborationProjection(
      [duplicate, duplicate, event({ source_event_id: 'other', mission_id: 'MSN-B' })],
      { missionId: 'MSN-A' }
    );
    expect(projection.overview.events).toBe(1);
    expect(projection.events[0]?.summary).toContain('[redacted]');
    expect(projection.events[0]?.mission_id).toBe('MSN-A');
  });

  it('fails closed when filtering the collaboration projection by tenant', () => {
    const projection = composeAgentCollaborationProjection(
      [
        event({ source_event_id: 'tenant-a', tenant_slug: 'client-a' }),
        event({ source_event_id: 'tenant-b', tenant_slug: 'client-b' }),
        event({ source_event_id: 'unscoped' }),
      ],
      { tenant: 'client-a' }
    );

    expect(projection.events).toHaveLength(1);
    expect(projection.events[0]?.tenant_slug).toBe('client-a');
  });

  it('carries the canonical entity scope into the collaboration projection', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source_event_id: 'scoped-task',
        tier: 'confidential',
        tenant_slug: 'client-a',
        organization_id: 'org-a',
        project_id: 'project-a',
        mission_id: 'MSN-A',
        task_id: 'task-a',
      }),
    ]);

    expect(projection.events[0]).toMatchObject({
      scope_kind: 'task',
      scope: {
        scope_kind: 'task',
        tenant_slug: 'client-a',
        organization_id: 'org-a',
        project_id: 'project-a',
      },
    });
  });

  it('filters collaboration events by organization, project and task scope', () => {
    const projection = composeAgentCollaborationProjection(
      [
        event({
          source_event_id: 'match',
          tier: 'confidential',
          tenant_slug: 'client-a',
          organization_id: 'org-a',
          project_id: 'project-a',
          mission_id: 'MSN-A',
          task_id: 'task-a',
        }),
        event({
          source_event_id: 'other-project',
          tier: 'confidential',
          tenant_slug: 'client-a',
          organization_id: 'org-a',
          project_id: 'project-b',
          mission_id: 'MSN-B',
          task_id: 'task-b',
        }),
      ],
      {
        tenant: 'client-a',
        scopeFilter: {
          organization_id: 'org-a',
          project_id: 'project-a',
          task_id: 'task-a',
        },
      }
    );

    expect(projection.events.map((entry) => entry.source_event_id)).toEqual(['match']);
  });

  it('surfaces sequence gaps and stale active runtime state', () => {
    const projection = composeAgentCollaborationProjection(
      [
        event({
          source: 'runtime',
          source_event_id: 'runtime-1',
          seq: 1,
          state_after: 'busy',
          ts: '2026-07-26T00:00:00.000Z',
        }),
        event({
          source: 'runtime',
          source_event_id: 'runtime-3',
          seq: 3,
          state_after: 'busy',
          ts: '2026-07-26T00:01:00.000Z',
        }),
      ],
      { now: '2026-07-26T01:00:00.000Z', staleAfterMs: 5 * 60 * 1000 }
    );

    expect(projection.status_flags).toEqual(['sequence_gap', 'stale_runtime']);
    expect(projection.sequence_gaps).toEqual([
      { source: 'runtime', previous_seq: 1, expected_seq: 2, actual_seq: 3 },
    ]);
    expect(projection.partial).toBe(true);
  });

  it('projects native adopter metadata and counts unavailable adoption attempts', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source_event_id: 'native-child',
        kind: 'spawn',
        provider: 'codex',
        native: true,
        native_fork: true,
        native_mode: 'thread-fork',
        effort: 'medium',
        parent_thread_id: 'parent-thread',
        thread_id: 'child-thread',
        turn_id: 'turn-1',
      }),
      event({
        source_event_id: 'native-missing',
        kind: 'failure',
        provider: 'codex',
        native_unavailable: true,
      }),
    ]);

    expect(projection.overview).toMatchObject({
      native_subagents: 1,
      unavailable_subagents: 1,
    });
    expect(projection.events.find((entry) => entry.thread_id === 'child-thread')).toMatchObject({
      thread_id: 'child-thread',
      parent_thread_id: 'parent-thread',
      native_fork: true,
      effort: 'medium',
    });
  });

  it('keeps human approval distinct from agent failure in attention', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source: 'surface',
        source_event_id: 'approval-1',
        actor_type: 'human',
        kind: 'approval',
        summary: '本番反映の承認待ち',
      }),
      event({
        source: 'runtime',
        source_event_id: 'failure-1',
        actor_type: 'agent',
        kind: 'failure',
        summary: 'worker crashed',
      }),
    ]);

    expect(projection.overview.waiting_human).toBe(1);
    expect(projection.overview.failures).toBe(1);
    expect(projection.attention.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['failure', 'approval'])
    );
  });

  it('replays the 3-to-10 agent golden scenario deterministically', () => {
    const fixture = JSON.parse(
      String(
        safeReadFile(pathResolver.rootResolve('tests/fixtures/agent-collaboration-golden.json'), {
          encoding: 'utf8',
        })
      )
    ) as { events: Array<Parameters<typeof createAgentCollaborationEvent>[0]> };
    const sequenceBySource = new Map<string, number>();
    const input = fixture.events.map((entry) => {
      const nextSequence = (sequenceBySource.get(entry.source) || 0) + 1;
      sequenceBySource.set(entry.source, nextSequence);
      return createAgentCollaborationEvent({ ...entry, seq: nextSequence });
    });
    const first = composeAgentCollaborationProjection(input, { now: '2026-07-26T01:00:00.000Z' });
    const replay = composeAgentCollaborationProjection(input, { now: '2026-07-26T01:00:00.000Z' });

    expect(replay).toEqual(first);
    expect(first.overview).toMatchObject({
      events: 16,
      missions: 1,
      tasks: 10,
      agents: 10,
      waiting_human: 1,
      review_pending: 1,
      failures: 1,
    });
    expect(first.attention.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['approval', 'review', 'failure'])
    );
    expect(first.edges.length).toBeGreaterThanOrEqual(10);
    expect(first.status_flags).toEqual([]);
  });

  it('skips worker event symlinks that escape the repository boundary', () => {
    const suffix = `agent-collaboration-${randomUUID()}`;
    const workerEventsDir = pathResolver.shared('logs/worker-events');
    const linkPath = path.join(workerEventsDir, `${suffix}.jsonl`);
    const externalPath = path.join(pathResolver.shared('tmp'), `${suffix}.jsonl`);
    fs.mkdirSync(workerEventsDir, { recursive: true });
    fs.mkdirSync(path.dirname(externalPath), { recursive: true });
    fs.writeFileSync(
      externalPath,
      `${JSON.stringify({
        event_id: `${suffix}-external`,
        type: 'progress',
        mission_id: suffix.toUpperCase(),
        summary: 'must not be projected',
      })}\n`
    );
    fs.symlinkSync(externalPath, linkPath);
    try {
      const projection = buildAgentCollaborationProjection({
        missionId: suffix,
        now: '2026-08-31T00:00:00.000Z',
      });
      expect(projection.events).toEqual([]);
      expect(fs.readFileSync(externalPath, 'utf8')).toContain('must not be projected');
    } finally {
      fs.unlinkSync(linkPath);
      fs.unlinkSync(externalPath);
    }
  });

  it('skips worker event paths that are directories', () => {
    const suffix = `agent-collaboration-directory-${randomUUID()}`;
    const workerEventsDir = pathResolver.shared('logs/worker-events');
    const directoryPath = path.join(workerEventsDir, `${suffix}.jsonl`);
    fs.mkdirSync(directoryPath, { recursive: true });

    try {
      const projection = buildAgentCollaborationProjection({
        missionId: suffix,
        now: '2026-08-31T00:00:00.000Z',
      });
      expect(projection.events).toEqual([]);
    } finally {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  });
});
