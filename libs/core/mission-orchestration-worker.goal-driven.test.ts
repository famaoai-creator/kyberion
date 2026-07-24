import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goalIdForWorkItem, runGoalDrivenWorkItem } from './mission-orchestration-worker.js';
import { DynamicInjectionRegistry } from './dynamic-injection.js';
import type { GenerateWithToolsResult, ReasoningBackend } from './reasoning-backend.js';
import { WorkerEventStream, type WorkerEventEnvelope } from './worker-event-stream.js';
import { WorkerStateJournal } from './worker-state-journal.js';
import { createGoal, type GoalRuntimeState } from './worker-goal.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';

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
});

afterEach(() => {
  for (const rel of journalPaths.splice(0)) {
    const abs = pathResolver.rootResolve(rel);
    if (safeExistsSync(abs)) safeRmSync(abs, { force: true });
    if (safeExistsSync(`${abs}.index.json`)) safeRmSync(`${abs}.index.json`, { force: true });
  }
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
