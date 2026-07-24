import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// KP-01: goal-driven dispatch's context-pack provisioning
// (provisionGoalDrivenTaskKnowledge) goes through provisionTaskKnowledge ->
// resolveMissionContextPack. Mock resolveMissionContextPack to a
// deterministic fixture pack (same technique as
// task-knowledge-provisioning.test.ts) so these tests stay hermetic — real
// selection/search behavior is covered by mission-context-pack.test.ts and
// distill-knowledge-injector.test.ts.
const mocks = vi.hoisted(() => ({
  resolveMissionContextPack: vi.fn(),
}));

vi.mock('./mission-context-pack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mission-context-pack.js')>();
  return {
    ...actual,
    resolveMissionContextPack: mocks.resolveMissionContextPack,
  };
});

import {
  goalIdForWorkItem,
  provisionGoalDrivenTaskKnowledge,
  runGoalDrivenWorkItem,
} from './mission-orchestration-worker.js';
import { buildMissionContextPack, type MissionContextPack } from './mission-context-pack.js';
import { DynamicInjectionRegistry } from './dynamic-injection.js';
import type { GenerateWithToolsResult, ReasoningBackend } from './reasoning-backend.js';
import { WorkerEventStream, type WorkerEventEnvelope } from './worker-event-stream.js';
import { WorkerStateJournal } from './worker-state-journal.js';
import { createGoal, type GoalRuntimeState } from './worker-goal.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { logger } from './core.js';

// KD-01 adoption: opt-in goal-driven execution in the mission orchestration
// worker. These exercise the exported dispatch-path seam with a stub backend,
// an injected event stream, and a real (tmp) KD-03 journal — fully hermetic.

type ToolBackend = Pick<ReasoningBackend, 'generateWithTools'> & { prompts: string[] };

function scriptedBackend(script: GenerateWithToolsResult[]): ToolBackend {
  let index = 0;
  const prompts: string[] = [];
  return {
    prompts,
    async generateWithTools(prompt: string): Promise<GenerateWithToolsResult> {
      prompts.push(prompt);
      const result = script[index] ?? { text: '[out of script]' };
      index += 1;
      return result;
    },
  };
}

const goalUpdate = (input: Record<string, unknown>): GenerateWithToolsResult => ({
  toolCalls: [{ name: 'goal_update', input }],
});

let journalCounter = 0;
const journalPaths: string[] = [];

function freshJournal(): WorkerStateJournal {
  const rel = `active/shared/tmp/goal-driven-tests/journal-${process.pid}-${journalCounter++}.jsonl`;
  journalPaths.push(rel);
  return new WorkerStateJournal({ journalPath: rel });
}

function goalEventSequence(events: WorkerEventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'status_update')
    .map((event) => String((event.payload as { goal_event?: string }).goal_event));
}

function appliedSequence(events: WorkerEventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'turn_end')
    .map((event) => String((event.payload as { applied?: string }).applied));
}

let events: WorkerEventEnvelope[];
let stream: WorkerEventStream;
let injectionRegistry: DynamicInjectionRegistry;

beforeEach(() => {
  events = [];
  stream = new WorkerEventStream();
  stream.subscribe((event) => events.push(event));
  injectionRegistry = new DynamicInjectionRegistry();
  mocks.resolveMissionContextPack.mockReset();
});

// Full WorkItem (not the pack's compact summary type) — reused both to build
// the fixture pack's `workItem` field and as provisionGoalDrivenTaskKnowledge's
// `workItem` input, exactly like dispatchGoalDrivenMissionTask does in
// production (it passes the WorkItem it just built via importExternalWorkItem).
function fixtureWorkItem(missionId: string, itemId: string) {
  return {
    item_id: itemId,
    title: 'Goal-driven KP-01 fixture work item',
    description: 'Deterministic work item used for the goal-driven provisioning test.',
    status: 'ready' as const,
    priority: 'normal' as const,
    source: 'local' as const,
    source_ref: `mission:${missionId}:${itemId}:goal`,
    project_id: `PRJ-GD-KP01-${process.pid}`,
    labels: [`mission:${missionId}`, 'goal_driven'],
    dependencies: [] as string[],
    version: 1,
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  };
}

function buildGoalDrivenFixture(input: {
  missionId: string;
  itemId: string;
  contextPackId: string;
}) {
  const workItem = fixtureWorkItem(input.missionId, input.itemId);
  const pack = buildMissionContextPack({
    contextPackId: input.contextPackId,
    // buildMissionContextPack's pruning step writes a rollup under
    // `missionPath`; route it to the governed tmp root instead of the real
    // (unauthorized-for-tests) mission directory.
    missionPath: pathResolver.sharedTmp(`kp01-goal-driven-test/rollup-${process.pid}`),
    missionState: {
      mission_id: input.missionId,
      tier: 'public',
      status: 'active',
      execution_mode: 'local',
      priority: 3,
      assigned_persona: 'worker',
      confidence_score: 1,
      git: { branch: 'main', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
      history: [],
    },
    teamRole: 'implementer',
    recipientKind: 'agent',
    assigneePeerId: 'agent-1',
    workItem,
    knowledgeHints: [
      {
        path: 'knowledge/product/architecture/kp01-goal-driven-hint.md',
        title: 'KP-01 Goal-Driven Fixture Hint',
        excerpt: 'Deterministic hint content the goal-driven first turn prompt must surface.',
        tags: ['kp-01'],
        score: 0.6,
      },
    ],
  });
  return { pack, workItem };
}

afterEach(() => {
  for (const rel of journalPaths.splice(0)) {
    const abs = pathResolver.rootResolve(rel);
    if (safeExistsSync(abs)) safeRmSync(abs, { force: true });
    if (safeExistsSync(`${abs}.index.json`)) safeRmSync(`${abs}.index.json`, { force: true });
  }
  const rollupPath = pathResolver.sharedTmp(`kp01-goal-driven-test/rollup-${process.pid}`);
  if (safeExistsSync(rollupPath)) safeRmSync(rollupPath, { recursive: true, force: true });
});

describe('acceptance #1: goal-driven work item runs multi-turn to structured completion', () => {
  it('drives create -> turns -> complete, with the KC-02 envelope sequence observable', async () => {
    const backend = scriptedBackend([
      goalUpdate({ status: 'continue' }),
      goalUpdate({ status: 'continue' }),
      goalUpdate({ status: 'complete', reason: 'every acceptance criterion verified' }),
    ]);
    const journal = freshJournal();
    const reportBlockerToMission = vi.fn();

    const result = await runGoalDrivenWorkItem({
      missionId: 'MSN-GD-1',
      task: { task_id: 'T1', goal_driven: true, description: 'produce the deliverable' },
      teamRole: 'implementer',
      agentId: 'agent-1',
      seams: { backend, stream, injectionRegistry, journal, reportBlockerToMission },
    });

    expect(result.finalState).toBe('complete');
    expect(result.turnsRun).toBe(3);
    expect(result.escalated).toBe(false);
    expect(result.persisted).toBeNull(); // complete is transient, never persisted
    expect(reportBlockerToMission).not.toHaveBeenCalled();

    // KC-02 envelope sequence (turn boundaries + goal lifecycle) is observable.
    expect(goalEventSequence(events)).toEqual(['created', 'completed', 'cleared']);
    expect(appliedSequence(events)).toEqual(['continue', 'continue', 'complete']);
    expect(events.filter((e) => e.type === 'turn_begin').map((e) => e.payload.turn)).toEqual([
      1, 2, 3,
    ]);

    // KD-03: the completed goal is cleared in the journal (transient, not at rest).
    const restored = journal.restore();
    expect(restored.goal).toBeNull();
    expect(restored.pendingReminder?.origin).toBe('goal_cancel');
    expect(journal.summary().goalState).toBeNull();
  });

  it('honors an opt-in KD-02 turn budget without inventing one', async () => {
    // turnBudget of 1: after one continue turn the budget is reached; because the
    // turn ended in a tool call, a grace step runs and the goal settles blocked.
    const backend = scriptedBackend([
      goalUpdate({ status: 'continue' }),
      { text: 'final status: partial progress recorded, remaining work handed off.' },
    ]);
    const journal = freshJournal();

    const result = await runGoalDrivenWorkItem({
      missionId: 'MSN-GD-BUDGET',
      task: {
        task_id: 'TB',
        goal_driven: true,
        description: 'unbounded research',
        goal_budget: { turnBudget: 1 },
      },
      seams: { backend, stream, injectionRegistry, journal, reportBlockerToMission: vi.fn() },
    });

    expect(result.finalState).toBe('blocked');
    expect(result.finalReport).toContain('partial progress');
    expect(goalEventSequence(events)).toContain('budget_reached');
  });
});

describe('acceptance #3: kill/restart -> restore yields a paused goal that does not self-advance', () => {
  it('restores an active goal as paused, halts without resume, then completes on explicit resume', async () => {
    const missionId = 'MSN-GD-RESUME';
    const taskId = 'TR';
    const goalId = goalIdForWorkItem(missionId, taskId);
    const rel = `active/shared/tmp/goal-driven-tests/journal-${process.pid}-resume.jsonl`;
    journalPaths.push(rel);

    // Simulate a prior process that died mid-turn: only the `active` checkpoint
    // was written to the journal.
    const seed = new WorkerStateJournal({ journalPath: rel });
    seed.recordGoal(createGoal({ goalId, objective: 'produce the deliverable', missionId }));

    const task = { task_id: taskId, goal_driven: true, description: 'produce the deliverable' };

    // Restart #1 (no explicit resume): the loop must NOT self-advance.
    const haltBackend = scriptedBackend([goalUpdate({ status: 'complete', reason: 'x' })]);
    const halted = await runGoalDrivenWorkItem({
      missionId,
      task,
      seams: {
        backend: haltBackend,
        stream,
        injectionRegistry,
        journal: new WorkerStateJournal({ journalPath: rel }),
        reportBlockerToMission: vi.fn(),
      },
    });
    expect(halted.finalState).toBe('paused');
    expect(halted.turnsRun).toBe(0);
    expect(haltBackend.prompts).toHaveLength(0); // the backend was never called
    expect(goalEventSequence(events)).toContain('resume_paused');

    // Restart #2 (explicit resume): the goal resumes and completes.
    events.length = 0;
    const resumeBackend = scriptedBackend([goalUpdate({ status: 'complete', reason: 'done now' })]);
    const resumed = await runGoalDrivenWorkItem({
      missionId,
      task,
      seams: {
        backend: resumeBackend,
        stream,
        injectionRegistry,
        journal: new WorkerStateJournal({ journalPath: rel }),
        reportBlockerToMission: vi.fn(),
        resume: true,
      },
    });
    expect(resumed.finalState).toBe('complete');
    expect(resumeBackend.prompts.length).toBeGreaterThan(0);
    expect(appliedSequence(events)).toContain('complete');
  });
});

describe('acceptance #4: a blocked goal is escalated via the existing reporting path', () => {
  it('escalates through mission events + reportBlockerToMission + the journal (not mission state)', async () => {
    // Same blocker three consecutive turns clears the KD-01 persistence threshold.
    const backend = scriptedBackend([
      goalUpdate({ status: 'blocked', reason: 'needs an external credential' }),
      goalUpdate({ status: 'blocked', reason: 'needs an external credential' }),
      goalUpdate({ status: 'blocked', reason: 'needs an external credential' }),
    ]);
    const journal = freshJournal();
    const reportBlockerToMission = vi.fn();

    const result = await runGoalDrivenWorkItem({
      missionId: 'MSN-GD-BLOCK',
      task: { task_id: 'TX', goal_driven: true, description: 'call the gated API' },
      teamRole: 'implementer',
      seams: { backend, stream, injectionRegistry, journal, reportBlockerToMission },
    });

    expect(result.finalState).toBe('blocked');
    expect(result.escalated).toBe(true);

    // Escalation surfaced via the worker mission-event path (never mission state).
    const missionEvents = events.filter((e) => e.type === 'mission_event');
    expect(missionEvents.map((e) => (e.payload as { kind?: string }).kind)).toContain(
      'goal_blocked'
    );
    // Escalation surfaced via the existing reportBlockerToMission reporting path.
    expect(reportBlockerToMission).toHaveBeenCalledTimes(1);
    const escalatedState = reportBlockerToMission.mock.calls[0][0] as GoalRuntimeState;
    expect(escalatedState.state).toBe('blocked');
    expect(escalatedState.terminalReason).toContain('external credential');

    // KD-03: the blocked goal is persisted at rest and asserted from the journal.
    const restored = journal.restore();
    expect(restored.goal?.state).toBe('blocked');
    expect(restored.goal?.goalId).toBe(goalIdForWorkItem('MSN-GD-BLOCK', 'TX'));
  });
});

// KP-01: goal-driven dispatch was the most knowledge-starved path (systemPrompt
// existed on RunGoalDrivenLoopOptions but nothing ever populated it). These
// tests exercise provisionGoalDrivenTaskKnowledge — the seam
// dispatchGoalDrivenMissionTask calls to build that systemPrompt — the same
// way mission-orchestration-worker.goal-driven.test.ts already exercises
// runGoalDrivenWorkItem: real function, fake backend/journal/stream, mocked
// resolveMissionContextPack for a deterministic fixture pack.
describe('KP-01: goal-driven dispatch context-pack provisioning', () => {
  const kp01MissionIds: string[] = [];

  beforeEach(() => {
    // provisionGoalDrivenTaskKnowledge saves under the real mission dir
    // (missionDir(missionId, 'public')), same as the single-shot path.
    process.env.MISSION_ROLE = 'mission_controller';
  });

  afterEach(() => {
    for (const missionId of kp01MissionIds.splice(0)) {
      const missionPath = pathResolver.missionDir(missionId, 'public');
      if (safeExistsSync(missionPath)) safeRmSync(missionPath, { recursive: true, force: true });
    }
    delete process.env.MISSION_ROLE;
  });

  it('provisions a systemPrompt whose first-turn prompt in the goal loop carries the context pack (knowledge hints + mission summary), as a stable prefix', async () => {
    const missionId = 'MSN-GD-KP01-TURN';
    kp01MissionIds.push(missionId);
    const { pack, workItem } = buildGoalDrivenFixture({
      missionId,
      itemId: 'WIT-GD-KP01-TURN',
      contextPackId: 'CPK-GD-KP01-TURN-00000001',
    });
    mocks.resolveMissionContextPack.mockResolvedValue(pack);

    const provisioned = await provisionGoalDrivenTaskKnowledge({
      missionId,
      task: { task_id: 'T1', goal_driven: true, description: 'produce the deliverable' },
      teamRole: 'implementer',
      agentId: 'agent-1',
      workItem,
    });

    expect(provisioned.systemPrompt).toContain('KP-01 Goal-Driven Fixture Hint');
    expect(provisioned.systemPrompt).toContain(
      'knowledge/product/architecture/kp01-goal-driven-hint.md'
    );
    expect(provisioned.systemPrompt).toContain(missionId);
    expect(provisioned.systemPrompt).toContain('stable prefix');

    // Wire it exactly as dispatchGoalDrivenMissionTask does: pass it once as
    // `systemPrompt`, not re-rendered per turn (KD-08 prompt-cache discipline).
    const backend = scriptedBackend([
      goalUpdate({ status: 'complete', reason: 'context pack observed' }),
    ]);
    const journal = freshJournal();
    const result = await runGoalDrivenWorkItem({
      missionId,
      task: { task_id: 'T1', goal_driven: true, description: 'produce the deliverable' },
      teamRole: 'implementer',
      agentId: 'agent-1',
      systemPrompt: provisioned.systemPrompt,
      seams: { backend, stream, injectionRegistry, journal, reportBlockerToMission: vi.fn() },
    });

    expect(result.finalState).toBe('complete');
    expect(backend.prompts).toHaveLength(1);
    // Acceptance criterion: the goal-driven task's first-turn prompt contains
    // context-pack-derived content.
    expect(backend.prompts[0]).toContain('KP-01 Goal-Driven Fixture Hint');
    expect(backend.prompts[0]).toContain(missionId);
  });

  describe('persistence', () => {
    const missionId = 'MSN-GD-KP01-SAVE';

    it('persists the pack under the mission coordination dir, same as the single-shot path', async () => {
      kp01MissionIds.push(missionId);
      const { pack, workItem } = buildGoalDrivenFixture({
        missionId,
        itemId: 'WIT-GD-KP01-SAVE',
        contextPackId: 'CPK-GD-KP01-SAVE-00000001',
      });
      mocks.resolveMissionContextPack.mockResolvedValue(pack);

      const provisioned = await provisionGoalDrivenTaskKnowledge({
        missionId,
        task: { task_id: 'T1', goal_driven: true, description: 'produce the deliverable' },
        teamRole: 'implementer',
        agentId: 'agent-1',
        workItem,
      });

      const expectedPath = `${pathResolver.missionDir(missionId, 'public')}/coordination/context-packs/${pack.context_pack_id}.json`;
      expect(provisioned.missionContextPackPath).toBe(expectedPath);
      expect(safeExistsSync(expectedPath)).toBe(true);
      const saved = JSON.parse(safeReadFile(expectedPath, { encoding: 'utf8' }) as string);
      expect(saved.context_pack_id).toBe(pack.context_pack_id);
    });
  });

  it('fails open when provisioning throws: returns no systemPrompt, logs a warning, never throws', async () => {
    mocks.resolveMissionContextPack.mockRejectedValue(new Error('kaboom: resolution failed'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const provisioned = await provisionGoalDrivenTaskKnowledge({
        missionId: 'MSN-GD-KP01-FAIL',
        task: { task_id: 'T1', goal_driven: true, description: 'produce the deliverable' },
        teamRole: 'implementer',
        agentId: 'agent-1',
        workItem: fixtureWorkItem('MSN-GD-KP01-FAIL', 'WIT-GD-KP01-FAIL'),
      });

      expect(provisioned).toEqual({});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('MSN-GD-KP01-FAIL');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('dispatch never blocks on a provisioning failure: the goal loop still runs to completion without a systemPrompt', async () => {
    mocks.resolveMissionContextPack.mockRejectedValue(new Error('kaboom: resolution failed'));
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const provisioned = await provisionGoalDrivenTaskKnowledge({
      missionId: 'MSN-GD-KP01-FAIL-2',
      task: { task_id: 'T1', goal_driven: true, description: 'produce the deliverable' },
      teamRole: 'implementer',
      agentId: 'agent-1',
      workItem: fixtureWorkItem('MSN-GD-KP01-FAIL-2', 'WIT-GD-KP01-FAIL-2'),
    });
    expect(provisioned.systemPrompt).toBeUndefined();

    const backend = scriptedBackend([
      goalUpdate({ status: 'complete', reason: 'done without a pack' }),
    ]);
    const journal = freshJournal();
    const result = await runGoalDrivenWorkItem({
      missionId: 'MSN-GD-KP01-FAIL-2',
      task: { task_id: 'T1', goal_driven: true, description: 'produce the deliverable' },
      teamRole: 'implementer',
      agentId: 'agent-1',
      ...(provisioned.systemPrompt ? { systemPrompt: provisioned.systemPrompt } : {}),
      seams: { backend, stream, injectionRegistry, journal, reportBlockerToMission: vi.fn() },
    });

    expect(result.finalState).toBe('complete');
  });
});
