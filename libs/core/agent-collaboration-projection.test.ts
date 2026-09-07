import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// AC-08: `node:fs` is a native ESM namespace whose exports are
// non-configurable, so `vi.spyOn(fs, 'readFileSync')` cannot redefine them.
// Mocking the module with a `vi.fn` wrapper around the real implementation
// gives the bounded-reader test below a spyable reference (shared by this
// file's default import and secure-io's namespace import) while every other
// export stays real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = vi.fn(actual.readFileSync);
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  buildAgentCollaborationProjection,
  composeAgentCollaborationProjection,
} from './agent-collaboration-projection.js';
import { createAgentCollaborationEvent } from './agent-collaboration-events.js';
import {
  appendPeerConversationTranscript,
  clearPeerConversationRuntime,
} from './peer-conversation.js';

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
    // AC-09: surfaces translate from `code`; core's title/next_action stay
    // developer-facing English and carry no localized text.
    expect(projection.attention.map((item) => item.code)).toEqual(
      expect.arrayContaining(['failure', 'waiting_human'])
    );
    expect(projection.attention.find((item) => item.code === 'waiting_human')).toMatchObject({
      title: 'Waiting for human approval',
      next_action: 'Review the request in the approval queue',
    });
  });

  it('labels every attention item with a closed reason code (AC-09)', () => {
    const projection = composeAgentCollaborationProjection([
      // Distinct timestamps: `event()` leaves event_id random, which is the
      // ordering tiebreaker, so equal ts would make the order unstable.
      event({
        source_event_id: 'blocked-1',
        kind: 'blocked',
        summary: 'no input',
        ts: '2026-07-26T00:00:01.000Z',
      }),
      event({
        source_event_id: 'approval-1',
        kind: 'approval',
        summary: 'sign-off',
        ts: '2026-07-26T00:00:02.000Z',
      }),
      event({
        source_event_id: 'review-1',
        kind: 'review',
        summary: 'check it',
        ts: '2026-07-26T00:00:03.000Z',
      }),
      event({
        source_event_id: 'failure-1',
        kind: 'failure',
        summary: 'crashed',
        ts: '2026-07-26T00:00:04.000Z',
      }),
      event({
        source_event_id: 'progress-1',
        kind: 'progress',
        summary: 'still going',
        ts: '2026-07-26T00:00:05.000Z',
      }),
    ]);
    expect(
      projection.attention.map((item) => ({ kind: item.kind, code: item.code, title: item.title }))
    ).toEqual([
      // newest first; the progress event raises no attention item at all.
      { kind: 'failure', code: 'failure', title: 'Failed' },
      { kind: 'review', code: 'review_pending', title: 'Review pending' },
      { kind: 'approval', code: 'waiting_human', title: 'Waiting for human approval' },
      { kind: 'blocked', code: 'blocked', title: 'Blocked' },
    ]);
    // `reason` stays the event summary, unchanged by AC-09.
    expect(projection.attention.map((item) => item.reason)).toEqual([
      'crashed',
      'check it',
      'sign-off',
      'no input',
    ]);
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
      // The golden approval (ACE-GOLDEN-014) is already `approved`, so it is
      // neither a human wait nor an attention item.
      waiting_human: 0,
      review_pending: 1,
      failures: 1,
    });
    expect(first.attention.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['review', 'failure'])
    );
    expect(first.attention.map((item) => item.kind)).not.toContain('approval');
    expect(first.edges.length).toBeGreaterThanOrEqual(10);
    expect(first.status_flags).toEqual([]);
  });

  it('builds an agent-to-agent handoff edge from a routed a2a message (AC-02a)', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source: 'orchestration',
        source_event_id: 'a2a-1',
        kind: 'handoff',
        sender: 'planner',
        receiver: 'worker-1',
        performative: 'request',
      }),
    ]);

    expect(projection.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'agent:planner', type: 'agent' }),
        expect.objectContaining({ id: 'agent:worker-1', type: 'agent' }),
      ])
    );
    expect(projection.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'agent:planner', to: 'agent:worker-1', kind: 'handoff' }),
      ])
    );
  });

  it('routes a human sender to a human: node for a handoff edge (AC-02a)', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source: 'surface',
        actor_type: 'human',
        source_event_id: 'a2a-human-1',
        kind: 'handoff',
        sender: 'operator',
        receiver: 'worker-1',
      }),
    ]);

    expect(projection.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'human:operator', type: 'human' })])
    );
    expect(projection.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'human:operator', to: 'agent:worker-1', kind: 'handoff' }),
      ])
    );
  });

  it('builds a spawn edge whose child state reflects the matching subagent_end (AC-02b)', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source: 'worker',
        source_event_id: 'begin-1',
        kind: 'spawn',
        parent_agent_id: 'planner',
        agent_id: 'child-1',
        delegation_id: 'DEL-1',
        ts: '2026-07-26T00:00:00.000Z',
      }),
      event({
        source: 'worker',
        source_event_id: 'end-1',
        kind: 'completion',
        agent_id: 'child-1',
        delegation_id: 'DEL-1',
        state_after: 'success',
        ts: '2026-07-26T00:01:00.000Z',
      }),
    ]);

    expect(projection.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'agent:planner', to: 'agent:child-1', kind: 'spawn' }),
      ])
    );
    expect(projection.nodes.find((node) => node.id === 'agent:child-1')).toMatchObject({
      state: 'success',
    });
  });

  it('leaves the spawned child state as running when no subagent_end has arrived yet (AC-02b)', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source: 'worker',
        source_event_id: 'begin-2',
        kind: 'spawn',
        parent_agent_id: 'planner',
        agent_id: 'child-2',
        delegation_id: 'DEL-2',
      }),
    ]);

    expect(projection.nodes.find((node) => node.id === 'agent:child-2')).toMatchObject({
      state: 'running',
    });
  });

  // AC-03 fixtures below build under an isolated `roots` override
  // (active/shared/tmp/collab-<uuid>/...) instead of the real, shared
  // observability files. Those real files can be tens of megabytes in the
  // main checkout and are read concurrently by other suites (vital_check,
  // Chronos, headless-projections) and processes; writing/truncating/deleting
  // them from a test is the exact class of shared-file race that has already
  // caused a CI flake here. Only the pre-existing symlink-boundary test below
  // still exercises the real paths, because it is specifically asserting
  // symlink-escape behaviour against the real worker-events directory.
  function collabFixtureDir(suffix: string): string {
    return path.join(pathResolver.shared('tmp'), `collab-${suffix}`);
  }

  it('truncates a large source file to its byte tail and flags bounded_read (AC-03)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const observabilityDir = path.join(fixtureDir, 'observability', 'mission-control');
    const filePath = path.join(observabilityDir, 'agent-runtime-supervisor-events.jsonl');
    const keptMissionId = `MSN-KEPT-${suffix}`.toUpperCase();
    const droppedMissionId = `MSN-DROPPED-${suffix}`.toUpperCase();
    const maxBytesPerFile = 2000;
    const padding = 'x'.repeat(200);
    const droppedLines = Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({
        event_id: `dropped-${suffix}-${index}`,
        ts: '2026-09-05T23:00:00.000Z',
        decision: 'agent_runtime_prewarm_requested',
        mission_id: droppedMissionId,
        seq: index,
        padding,
      })
    );
    const keptLines = Array.from({ length: 5 }, (_, index) =>
      JSON.stringify({
        event_id: `kept-${suffix}-${index}`,
        ts: '2026-09-05T23:30:00.000Z',
        decision: 'agent_runtime_prewarm_requested',
        mission_id: keptMissionId,
        seq: index,
        padding,
      })
    );
    const content = `${[...droppedLines, ...keptLines].join('\n')}\n`;
    fs.mkdirSync(observabilityDir, { recursive: true });
    fs.writeFileSync(filePath, content);
    try {
      expect(fs.statSync(filePath).size).toBeGreaterThan(maxBytesPerFile);
      const projection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        bounded: { maxBytesPerFile },
        roots: {
          observabilityDir,
          workerEventsDir: path.join(fixtureDir, 'logs', 'worker-events'),
        },
      });
      expect(projection.partial).toBe(true);
      expect(projection.status_flags).toContain('bounded_read');
      expect(projection.truncated_sources).toContain('agent-runtime-supervisor-events.jsonl');
      expect(projection.events.some((entry) => entry.mission_id === keptMissionId)).toBe(true);
      expect(projection.events.some((entry) => entry.mission_id === droppedMissionId)).toBe(false);

      const unboundedProjection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        bounded: false,
        roots: {
          observabilityDir,
          workerEventsDir: path.join(fixtureDir, 'logs', 'worker-events'),
        },
      });
      expect(unboundedProjection.status_flags).not.toContain('bounded_read');
      expect(
        unboundedProjection.events.some((entry) => entry.mission_id === droppedMissionId)
      ).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('ignores worker-events-<date>.jsonl files outside the recent-days window by default (AC-03)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const workerEventsDir = path.join(fixtureDir, 'logs', 'worker-events');
    const recentMissionId = `MSN-RECENT-${suffix}`.toUpperCase();
    const oldMissionId = `MSN-OLD-${suffix}`.toUpperCase();
    const recentPath = path.join(workerEventsDir, 'worker-events-2026-09-05.jsonl');
    const oldPath = path.join(workerEventsDir, 'worker-events-2026-09-01.jsonl');
    fs.mkdirSync(workerEventsDir, { recursive: true });
    fs.writeFileSync(
      recentPath,
      `${JSON.stringify({
        type: 'progress',
        mission_id: recentMissionId,
        ts: '2026-09-05T00:00:00.000Z',
      })}\n`
    );
    fs.writeFileSync(
      oldPath,
      `${JSON.stringify({
        type: 'progress',
        mission_id: oldMissionId,
        ts: '2026-09-01T00:00:00.000Z',
      })}\n`
    );
    try {
      const projection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(projection.events.some((entry) => entry.mission_id === recentMissionId)).toBe(true);
      expect(projection.events.some((entry) => entry.mission_id === oldMissionId)).toBe(false);

      const unboundedProjection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        bounded: false,
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(unboundedProjection.events.some((entry) => entry.mission_id === oldMissionId)).toBe(
        true
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('always includes a mission-scoped worker-event partition regardless of recentDays, but not other missions (AC-03 follow-up)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const workerEventsDir = path.join(fixtureDir, 'logs', 'worker-events');
    const targetMissionId = `MSN-TARGET-${suffix}`.toUpperCase();
    const otherMissionId = `MSN-OTHER-${suffix}`.toUpperCase();
    const targetMissionDir = path.join(workerEventsDir, 'missions', targetMissionId);
    const otherMissionDir = path.join(workerEventsDir, 'missions', otherMissionId);
    fs.mkdirSync(targetMissionDir, { recursive: true });
    fs.mkdirSync(otherMissionDir, { recursive: true });
    const oldDate = '2026-09-01';
    fs.writeFileSync(
      path.join(targetMissionDir, `worker-events-${oldDate}.jsonl`),
      `${JSON.stringify({
        type: 'progress',
        mission_id: targetMissionId,
        ts: `${oldDate}T00:00:00.000Z`,
      })}\n`
    );
    fs.writeFileSync(
      path.join(otherMissionDir, `worker-events-${oldDate}.jsonl`),
      `${JSON.stringify({
        type: 'progress',
        mission_id: otherMissionId,
        ts: `${oldDate}T00:00:00.000Z`,
      })}\n`
    );
    try {
      // Scoped to the target mission: its own old partition is read despite
      // being outside recentDays; the other mission's old partition is not.
      const scopedToTarget = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        missionId: targetMissionId,
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(scopedToTarget.events.some((entry) => entry.mission_id === targetMissionId)).toBe(
        true
      );
      expect(scopedToTarget.events.some((entry) => entry.mission_id === otherMissionId)).toBe(
        false
      );

      // Scoped the other way around, to prove this is genuinely a per-scope
      // read-layer decision and not an artifact of one mission's fixture data.
      const scopedToOther = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        missionId: otherMissionId,
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(scopedToOther.events.some((entry) => entry.mission_id === otherMissionId)).toBe(true);
      expect(scopedToOther.events.some((entry) => entry.mission_id === targetMissionId)).toBe(
        false
      );

      // Unscoped: recentDays applies to both mission partitions equally.
      const unscoped = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(unscoped.events.some((entry) => entry.mission_id === targetMissionId)).toBe(false);
      expect(unscoped.events.some((entry) => entry.mission_id === otherMissionId)).toBe(false);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('lifts payload.status of recorded subagent_end envelopes into the spawned child state (AC-02b)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const workerEventsDir = path.join(fixtureDir, 'logs', 'worker-events');
    const missionId = `MSN-SPAWN-${suffix}`.toUpperCase();
    const delegationId = `DEL-${suffix}`;
    const childId = `implementer:${suffix.slice(0, 8)}`;
    fs.mkdirSync(workerEventsDir, { recursive: true });
    const shared = {
      delegation_id: delegationId,
      agent_id: childId,
      parent_agent_id: 'kyberion://agent/orchestrator',
      team_role: 'implementer',
      dispatcher: 'harness-subagent',
      profile: 'implementer',
    };
    const lines = [
      {
        type: 'subagent_begin',
        ts: '2026-09-06T00:00:00.000Z',
        seq: 0,
        source: { mission_id: missionId },
        payload: shared,
      },
      {
        type: 'subagent_end',
        ts: '2026-09-06T00:00:05.000Z',
        seq: 1,
        source: { mission_id: missionId },
        payload: { ...shared, status: 'fallback', fallback_to: 'process-spawn', elapsed_ms: 5000 },
      },
    ];
    fs.writeFileSync(
      path.join(workerEventsDir, 'worker-events-2026-09-06.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    );
    try {
      const projection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:10.000Z',
        missionId,
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(projection.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'agent:kyberion://agent/orchestrator',
            to: `agent:${childId}`,
            kind: 'spawn',
          }),
        ])
      );
      expect(projection.nodes.find((node) => node.id === `agent:${childId}`)).toMatchObject({
        state: 'fallback',
      });
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('lifts payload.request_id and payload.channel of approval envelopes (AC-04)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const workerEventsDir = path.join(fixtureDir, 'logs', 'worker-events');
    const missionId = `MSN-APPROVAL-${suffix}`.toUpperCase();
    fs.mkdirSync(workerEventsDir, { recursive: true });
    const lines = [
      {
        type: 'approval_request',
        ts: '2026-09-06T00:00:00.000Z',
        seq: 0,
        source: { mission_id: missionId, agent_id: 'gatekeeper' },
        payload: {
          request_id: 'REQ-1',
          correlation_id: 'COR-1',
          requested_by: 'gatekeeper',
          channel: 'slack',
          status: 'pending',
        },
      },
    ];
    fs.writeFileSync(
      path.join(workerEventsDir, 'worker-events-2026-09-06.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    );
    try {
      const projection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:10.000Z',
        missionId,
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(projection.events[0]).toMatchObject({
        kind: 'approval',
        request_id: 'REQ-1',
        channel: 'slack',
        state_after: 'pending',
      });
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('applies the recent-days window to event timestamps and drops telemetry noise from unrotated sources (AC-03)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const observabilityDir = path.join(fixtureDir, 'observability', 'mission-control');
    const workerEventsDir = path.join(fixtureDir, 'logs', 'worker-events');
    const oldMissionId = `MSN-OLD-${suffix}`.toUpperCase();
    const freshMissionId = `MSN-FRESH-${suffix}`.toUpperCase();
    fs.mkdirSync(observabilityDir, { recursive: true });
    fs.mkdirSync(workerEventsDir, { recursive: true });
    const orchestration = [
      {
        ts: '2026-07-01T00:00:00.000Z',
        decision: 'mission_owner_notified',
        mission_id: oldMissionId,
      },
      {
        ts: '2026-09-05T12:00:00.000Z',
        decision: 'mission_owner_notified',
        mission_id: freshMissionId,
      },
    ];
    const supervisor = Array.from({ length: 50 }, (_, index) => ({
      ts: '2026-09-05T13:00:00.000Z',
      decision: 'a2a_inflight_metric',
      inflight_total: index,
    }));
    fs.writeFileSync(
      path.join(observabilityDir, 'orchestration-events.jsonl'),
      `${orchestration.map((line) => JSON.stringify(line)).join('\n')}\n`
    );
    fs.writeFileSync(
      path.join(observabilityDir, 'agent-runtime-supervisor-events.jsonl'),
      `${supervisor.map((line) => JSON.stringify(line)).join('\n')}\n`
    );
    try {
      const projection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        roots: { observabilityDir, workerEventsDir },
      });
      const missionIds = projection.nodes
        .filter((node) => node.type === 'mission')
        .map((n) => n.id);
      expect(missionIds).toContain(`mission:${freshMissionId}`);
      expect(missionIds).not.toContain(`mission:${oldMissionId}`);
      expect(projection.overview.events).toBe(1);
      expect(projection.status_flags).not.toContain('unknown_event');

      const unbounded = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        bounded: false,
        roots: { observabilityDir, workerEventsDir },
      });
      expect(unbounded.nodes.map((node) => node.id)).toContain(`mission:${oldMissionId}`);
      expect(unbounded.overview.events).toBe(52);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('drops an approval from attention once its response arrives (AC-09 follow-up)', () => {
    const projection = composeAgentCollaborationProjection([
      event({
        source: 'worker',
        source_event_id: 'req-1',
        kind: 'approval',
        request_id: 'REQ-1',
        agent_id: 'implementer-1',
        summary: 'pending',
        ts: '2026-09-05T00:00:00.000Z',
      }),
      event({
        source: 'worker',
        source_event_id: 'req-2',
        kind: 'approval',
        request_id: 'REQ-2',
        agent_id: 'implementer-2',
        summary: 'pending',
        ts: '2026-09-05T00:00:01.000Z',
      }),
      event({
        source: 'worker',
        source_event_id: 'res-1',
        kind: 'approval',
        request_id: 'REQ-1',
        agent_id: 'sovereign-user',
        state_after: 'approved',
        summary: 'approved',
        ts: '2026-09-05T00:01:00.000Z',
      }),
    ]);
    expect(projection.attention.map((item) => item.agent_id)).toEqual(['implementer-2']);
    expect(projection.attention[0]).toMatchObject({ code: 'waiting_human' });
    expect(projection.overview.waiting_human).toBe(1);
  });

  it('keeps limit as a cap on the returned feed only, not on the composed graph (AC-05 follow-up)', () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        source: 'orchestration',
        source_event_id: `evt-${index}`,
        kind: 'progress',
        mission_id: `MSN-LIMIT-${index}`,
        ts: `2026-09-05T00:00:${String(index).padStart(2, '0')}.000Z`,
      })
    );
    const projection = composeAgentCollaborationProjection(events, { limit: 5 });
    expect(projection.events).toHaveLength(5);
    expect(projection.overview.events).toBe(30);
    expect(projection.nodes.filter((node) => node.type === 'mission')).toHaveLength(30);
  });

  it('drops step/turn lifecycle worker events by default and keeps them with includeStepEvents (AC-03)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const workerEventsDir = path.join(fixtureDir, 'logs', 'worker-events');
    const stepMissionId = `MSN-STEP-${suffix}`.toUpperCase();
    const turnMissionId = `MSN-TURN-${suffix}`.toUpperCase();
    const filePath = path.join(workerEventsDir, 'worker-events-2026-09-06.jsonl');
    fs.mkdirSync(workerEventsDir, { recursive: true });
    const lines = [
      { type: 'step_begin', mission_id: stepMissionId, ts: '2026-09-06T00:00:00.000Z', seq: 1 },
      { type: 'mission_event', mission_id: turnMissionId, ts: '2026-09-06T00:00:01.000Z', seq: 2 },
    ];
    fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    try {
      const defaultProjection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(defaultProjection.events.some((entry) => entry.mission_id === stepMissionId)).toBe(
        false
      );
      expect(defaultProjection.events.some((entry) => entry.mission_id === turnMissionId)).toBe(
        true
      );

      const includedProjection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        bounded: { includeStepEvents: true },
        roots: { workerEventsDir, observabilityDir: path.join(fixtureDir, 'observability') },
      });
      expect(includedProjection.events.some((entry) => entry.mission_id === stepMissionId)).toBe(
        true
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
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

  it('reads an oversized source through the tail primitive and drops the torn leading line (AC-08)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const observabilityDir = path.join(fixtureDir, 'observability', 'mission-control');
    const filePath = path.join(observabilityDir, 'agent-runtime-supervisor-events.jsonl');
    const padding = 'x'.repeat(120);
    // Every mission id has the same width, so all six lines are the same
    // length and the byte cut below can be placed inside a chosen one.
    const missionIds = Array.from({ length: 6 }, (_, index) =>
      `MSN-TAIL-${index}-${suffix}`.toUpperCase()
    );
    const lines = missionIds.map((missionId) =>
      JSON.stringify({
        ts: '2026-09-05T23:30:00.000Z',
        decision: 'mission_owner_notified',
        mission_id: missionId,
        padding,
      })
    );
    const lineLength = lines[0].length + 1;
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    const content = `${lines.join('\n')}\n`;
    fs.mkdirSync(observabilityDir, { recursive: true });
    fs.writeFileSync(filePath, content);
    // Cut in the middle of line index 2: it becomes a torn fragment that must
    // be discarded, while lines 3..5 are complete and must survive.
    const tailStart = 2 * lineLength + Math.floor(lineLength / 2);
    const maxBytesPerFile = content.length - tailStart;
    try {
      const readFileSyncMock = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileSyncMock.mockClear();
      const projection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        bounded: { maxBytesPerFile },
        roots: {
          observabilityDir,
          workerEventsDir: path.join(fixtureDir, 'logs', 'worker-events'),
        },
      });
      const projected = projection.nodes.filter((node) => node.type === 'mission').map((n) => n.id);
      expect(projected).toEqual(
        expect.arrayContaining(missionIds.slice(3).map((id) => `mission:${id}`))
      );
      for (const missionId of missionIds.slice(0, 3)) {
        expect(projected).not.toContain(`mission:${missionId}`);
      }
      expect(projection.truncated_sources).toContain('agent-runtime-supervisor-events.jsonl');
      // The tail primitive seeks; the file is never loaded whole.
      const wholeFileReads = readFileSyncMock.mock.calls.filter((call: unknown[]) =>
        String(call[0]).endsWith('agent-runtime-supervisor-events.jsonl')
      );
      expect(wholeFileReads).toEqual([]);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('merges dated supervisor partitions inside the window with the legacy file (AC-10)', () => {
    const suffix = randomUUID();
    const fixtureDir = collabFixtureDir(suffix);
    const observabilityDir = path.join(fixtureDir, 'observability', 'mission-control');
    const legacyMissionId = `MSN-LEGACY-${suffix}`.toUpperCase();
    const recentMissionId = `MSN-RECENT-${suffix}`.toUpperCase();
    const oldMissionId = `MSN-OLD-${suffix}`.toUpperCase();
    fs.mkdirSync(observabilityDir, { recursive: true });
    const line = (missionId: string, ts: string) =>
      `${JSON.stringify({ ts, decision: 'mission_owner_notified', mission_id: missionId })}\n`;
    fs.writeFileSync(
      path.join(observabilityDir, 'agent-runtime-supervisor-events.jsonl'),
      line(legacyMissionId, '2026-09-05T10:00:00.000Z')
    );
    fs.writeFileSync(
      path.join(observabilityDir, 'agent-runtime-supervisor-events-2026-09-05.jsonl'),
      line(recentMissionId, '2026-09-05T11:00:00.000Z')
    );
    fs.writeFileSync(
      path.join(observabilityDir, 'agent-runtime-supervisor-events-2026-09-01.jsonl'),
      line(oldMissionId, '2026-09-01T11:00:00.000Z')
    );
    try {
      const projection = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        roots: {
          observabilityDir,
          workerEventsDir: path.join(fixtureDir, 'logs', 'worker-events'),
        },
      });
      const missionIds = projection.nodes.filter((n) => n.type === 'mission').map((n) => n.id);
      expect(missionIds).toContain(`mission:${recentMissionId}`);
      // The legacy partition stays in the read; only the `since` window hides
      // its genuinely old rows, and this one is inside the window.
      expect(missionIds).toContain(`mission:${legacyMissionId}`);
      expect(missionIds).not.toContain(`mission:${oldMissionId}`);
      expect(projection.sources).toContain('runtime');
      expect(projection.status_flags).not.toContain('unknown_event');

      const unbounded = buildAgentCollaborationProjection({
        now: '2026-09-06T00:00:00.000Z',
        bounded: false,
        roots: {
          observabilityDir,
          workerEventsDir: path.join(fixtureDir, 'logs', 'worker-events'),
        },
      });
      expect(unbounded.nodes.map((node) => node.id)).toContain(`mission:${oldMissionId}`);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('projects peer conversations as oriented a2a handoff edges, scoped by tenant (AC-11)', () => {
    const suffix = randomUUID().replace(/-/gu, '').slice(0, 12);
    const tenantId = `tenant-collab-${suffix}`;
    const otherTenantId = `tenant-other-${suffix}`;
    const localPeer = `peer-a-${suffix}`;
    const remotePeer = `peer-b-${suffix}`;
    const fixtureDir = collabFixtureDir(suffix);
    const roots = {
      observabilityDir: path.join(fixtureDir, 'observability', 'mission-control'),
      workerEventsDir: path.join(fixtureDir, 'logs', 'worker-events'),
    };
    appendPeerConversationTranscript({
      tenantId,
      sessionId: 'PCS-collab-1',
      localPeerId: localPeer,
      remotePeerId: remotePeer,
      kind: 'handoff',
      direction: 'outbound',
      text: 'take this over',
    });
    appendPeerConversationTranscript({
      tenantId,
      sessionId: 'PCS-collab-1',
      localPeerId: localPeer,
      remotePeerId: remotePeer,
      kind: 'reply',
      direction: 'inbound',
      text: 'acknowledged',
    });
    try {
      const projection = buildAgentCollaborationProjection({
        now: new Date(Date.now() + 60_000).toISOString(),
        tenant: tenantId,
        roots,
      });
      const handoffs = projection.edges.filter((edge) => edge.kind === 'handoff');
      // outbound: local → remote; inbound is flipped by readPeerConversationEdges.
      expect(handoffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: `agent:${localPeer}`, to: `agent:${remotePeer}` }),
          expect.objectContaining({ from: `agent:${remotePeer}`, to: `agent:${localPeer}` }),
        ])
      );
      expect(projection.sources).toContain('a2a');
      expect(projection.status_flags).not.toContain('unknown_event');
      const peerEvents = projection.events.filter((entry) => entry.source === 'a2a');
      expect(peerEvents).toHaveLength(2);
      const inbound = peerEvents.find((entry) => entry.sender === remotePeer);
      expect(inbound).toMatchObject({
        kind: 'handoff',
        agent_id: localPeer,
        receiver: localPeer,
        summary: 'reply',
        correlation_id: 'PCS-collab-1',
      });
      expect(inbound?.scope?.tenant_slug).toBe(tenantId);
      expect(inbound?.source_event_id).toMatch(/^PCM-/u);

      const otherTenantProjection = buildAgentCollaborationProjection({
        now: new Date(Date.now() + 60_000).toISOString(),
        tenant: otherTenantId,
        roots,
      });
      expect(otherTenantProjection.sources).not.toContain('a2a');
      expect(otherTenantProjection.edges).toEqual([]);
    } finally {
      clearPeerConversationRuntime(tenantId, localPeer);
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
