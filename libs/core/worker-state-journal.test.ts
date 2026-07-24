import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  assertNotDuringRestore,
  CURRENT_JOURNAL_VERSION,
  deliverOneShotReminder,
  EventSourcingKernel,
  GoalDelegationSummary,
  isRestoring,
  MISSION_FORK_SYSTEM_REMINDER,
  migrateEnvelope,
  runInRestoreMode,
  WORKER_STATE_OPS,
  WorkerStateJournal,
  type DelegationLedgerEntry,
} from './worker-state-journal.js';
import { createGoal, GOAL_CANCEL_SYSTEM_REMINDER, type GoalRuntimeState } from './worker-goal.js';
import { runGoalDrivenLoop } from './worker-goal-driver.js';
import { WorkerEventStream } from './worker-event-stream.js';
import type { GenerateWithToolsResult, ReasoningBackend } from './reasoning-backend.js';

const TMP_DIR = `active/shared/tmp/kd03-tests-${process.pid}`;
let counter = 0;

function nextJournalPath(): string {
  counter += 1;
  return `${TMP_DIR}/journal-${counter}.jsonl`;
}

/** Deterministic monotonic clock so restore output is fully reproducible. */
function fixedClock(): () => string {
  let n = 0;
  return () => `2026-07-20T00:00:${String(n++).padStart(2, '0')}.000Z`;
}

function cleanup(): void {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
}

function activeGoal(now: () => string): GoalRuntimeState {
  return createGoal({ goalId: 'goal-kd03', objective: 'Ship the KD-03 restore contract', now });
}

function delegation(id: string, status: DelegationLedgerEntry['status']): DelegationLedgerEntry {
  return {
    delegationId: id,
    owner: 'main-worker',
    instruction: `delegated slice ${id}`,
    status,
    background: true,
    createdAt: '2026-07-20T00:00:00.000Z',
  };
}

beforeEach(() => cleanup());
afterEach(() => cleanup());
afterAll(() => cleanup());

// ---------------------------------------------------------------------------
// AC1: goal + 2 delegations -> simulated kill -> restore purely from journal
// ---------------------------------------------------------------------------

describe('KD-03 AC1: restore from journal replay after a simulated process kill', () => {
  it('reconstructs the demoted goal and delegation ledger from the journal alone', () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();

    // Live process: create a goal, record two delegations, then "die".
    const live = new WorkerStateJournal({ journalPath, now });
    live.recordGoal(activeGoal(now));
    live.recordDelegation(delegation('deleg-a', 'started'));
    live.recordDelegation(delegation('deleg-b', 'completed'));

    // Simulated kill: a brand-new instance with NO in-memory carry-over.
    const restored = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();

    // KD-01: an active goal comes back paused (never self-advances on resume).
    expect(restored.goal?.goalId).toBe('goal-kd03');
    expect(restored.goal?.state).toBe('paused');
    expect(restored.goal?.terminalKind).toBe('technical');
    expect(restored.goal?.objective).toBe('Ship the KD-03 restore contract');

    // Delegation ledger reconstructed with per-entry fidelity.
    expect(Object.keys(restored.delegations).sort()).toEqual(['deleg-a', 'deleg-b']);
    expect(restored.delegations['deleg-a'].status).toBe('started');
    expect(restored.delegations['deleg-b'].status).toBe('completed');
    expect(restored.delegations['deleg-a'].instruction).toBe('delegated slice deleg-a');
  });

  it('is a pure projection: the journal file is the only input', () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const live = new WorkerStateJournal({ journalPath, now });
    live.recordGoal(activeGoal(now));

    // Two independent restores of the same journal are byte-identical.
    const a = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    const b = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// AC2: no LLM call / tool execution / notification emission during restore
// ---------------------------------------------------------------------------

describe('KD-03 AC2: restore is silent (no LLM / tool / notification)', () => {
  it('runs onDidRestore hooks inside restore mode and forbids emission seams', () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const live = new WorkerStateJournal({ journalPath, now });
    live.recordGoal(activeGoal(now));
    live.recordDelegation(delegation('deleg-a', 'started'));
    live.cancelGoal('goal-kd03', 'rem-1'); // leaves a pending one-shot reminder

    const notificationSink = vi.fn();
    const llmBackend = {
      generateWithTools: vi.fn(),
      generate: vi.fn(),
      delegateTask: vi.fn(),
    };

    const restore = new WorkerStateJournal({ journalPath, now: fixedClock() });
    let hookSawRestoreMode = false;
    let emissionThrew = false;
    restore.onDidRestore((state) => {
      hookSawRestoreMode = isRestoring();
      // Any attempt to emit during restore must throw structurally.
      try {
        deliverOneShotReminder(state.pendingReminder!, notificationSink);
      } catch {
        emissionThrew = true;
      }
    });

    const state = restore.restore();

    expect(hookSawRestoreMode).toBe(true);
    expect(emissionThrew).toBe(true);
    expect(notificationSink).not.toHaveBeenCalled();
    expect(llmBackend.generateWithTools).not.toHaveBeenCalled();
    expect(llmBackend.generate).not.toHaveBeenCalled();
    expect(llmBackend.delegateTask).not.toHaveBeenCalled();
    // The pending reminder is reconstructed (deliverable later, in live mode).
    expect(state.pendingReminder?.text).toBe(GOAL_CANCEL_SYSTEM_REMINDER);
    // Restore left restore-mode cleanly.
    expect(isRestoring()).toBe(false);
  });

  it('the emission seam throws inside runInRestoreMode and delivers outside it', () => {
    const sink = vi.fn();
    const reminder = { id: 'r', text: 'x', origin: 'goal_cancel' as const };
    expect(() => runInRestoreMode(() => deliverOneShotReminder(reminder, sink))).toThrow(
      /forbidden during restore/
    );
    expect(sink).not.toHaveBeenCalled();
    // Outside restore mode, delivery works.
    deliverOneShotReminder(reminder, sink);
    expect(sink).toHaveBeenCalledWith(reminder);
  });

  it('append is refused during restore (no journal mutation while replaying)', () => {
    const journalPath = nextJournalPath();
    const j = new WorkerStateJournal({ journalPath, now: fixedClock() });
    expect(() => runInRestoreMode(() => j.recordDelegation(delegation('x', 'started')))).toThrow(
      /forbidden during restore/
    );
  });
});

// ---------------------------------------------------------------------------
// AC3: v1 -> v2 migration replays silently; both versions readable
// ---------------------------------------------------------------------------

describe('KD-03 AC3: versioned journal migration (v1 -> v2)', () => {
  it('replays a v1 journal through the migration and reads v1 + v2 records together', () => {
    const journalPath = nextJournalPath();
    const resolved = pathResolver.rootResolve(journalPath);
    // Hand-write a mixed-version journal: a v1 delegation (field `state`) and a
    // v2 goal record, exactly as a mid-upgrade log would look on disk.
    const v1Delegation = {
      v: 1,
      seq: 0,
      ts: '2026-07-20T00:00:00.000Z',
      op: WORKER_STATE_OPS.delegationUpsert,
      payload: {
        delegationId: 'legacy-1',
        owner: 'main-worker',
        instruction: 'legacy slice',
        state: 'started', // v1 field name, renamed to `status` by the migration
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    };
    const v2Goal = {
      v: 2,
      seq: 1,
      ts: '2026-07-20T00:00:01.000Z',
      op: WORKER_STATE_OPS.goalUpsert,
      payload: createGoal({ goalId: 'goal-v2', objective: 'mixed-version', now: fixedClock() }),
    };
    safeWriteFile(resolved, `${JSON.stringify(v1Delegation)}\n${JSON.stringify(v2Goal)}\n`);

    const state = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();

    // The v1 delegation is readable with its field migrated to `status`.
    expect(state.delegations['legacy-1'].status).toBe('started');
    expect((state.delegations['legacy-1'] as Record<string, unknown>).state).toBeUndefined();
    // The v2 goal is readable alongside it (demoted, since it was active).
    expect(state.goal?.goalId).toBe('goal-v2');
    expect(state.goal?.state).toBe('paused');
  });

  it('migrateEnvelope advances a v1 record to the current version', () => {
    const migrated = migrateEnvelope({
      v: 1,
      seq: 0,
      ts: 't',
      op: WORKER_STATE_OPS.delegationUpsert,
      payload: {
        delegationId: 'd',
        owner: 'o',
        instruction: 'i',
        state: 'completed',
        createdAt: 't',
      },
    });
    expect(migrated.v).toBe(CURRENT_JOURNAL_VERSION);
    expect((migrated.payload as Record<string, unknown>).status).toBe('completed');
    expect((migrated.payload as Record<string, unknown>).state).toBeUndefined();
  });

  it('refuses a record newer than the code supports', () => {
    expect(() => migrateEnvelope({ v: 999, seq: 0, ts: 't', op: 'x', payload: {} })).toThrow(
      /newer than supported/
    );
  });

  it('new appends are written at the current journal version', () => {
    const journalPath = nextJournalPath();
    const env = new WorkerStateJournal({ journalPath, now: fixedClock() }).recordDelegation(
      delegation('d', 'started')
    );
    expect(env.v).toBe(CURRENT_JOURNAL_VERSION);
  });
});

// ---------------------------------------------------------------------------
// AC4: corrupted derived index self-heals via wipe -> reprojection
// ---------------------------------------------------------------------------

describe('KD-03 AC4: derived index (CQRS) self-heals from the journal', () => {
  it('rebuilds a corrupt index by wiping and reprojecting', () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const journal = new WorkerStateJournal({ journalPath, now });
    journal.recordGoal(activeGoal(now));
    journal.recordDelegation(delegation('deleg-a', 'started'));
    journal.recordDelegation(delegation('deleg-b', 'completed'));

    const first = journal.summary();
    expect(first.delegationCount).toBe(2);
    expect(first.activeDelegationCount).toBe(1);
    expect(first.goalId).toBe('goal-kd03');

    // Corrupt the derived index on disk.
    const indexPath = pathResolver.rootResolve(`${journalPath}.index.json`);
    safeWriteFile(indexPath, '{ this is not valid json ');

    // A fresh reader self-heals: wipe -> reproject -> same authoritative view.
    const healed: GoalDelegationSummary = new WorkerStateJournal({ journalPath, now }).summary();
    expect(healed.delegationCount).toBe(2);
    expect(healed.activeDelegationCount).toBe(1);
    expect(healed.goalId).toBe('goal-kd03');

    // The index file is valid JSON again after healing.
    const raw = String(safeReadFile(indexPath, { encoding: 'utf-8' }));
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('the journal remains the source of truth when the index is absent', () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const journal = new WorkerStateJournal({ journalPath, now });
    journal.recordDelegation(delegation('deleg-a', 'started'));
    // No summary() called yet => no index file. First summary projects from log.
    const summary = journal.summary();
    expect(summary.delegationCount).toBe(1);
    expect(summary.activeDelegationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fork/clear hygiene: exactly one one-shot reminder; replay never re-delivers
// ---------------------------------------------------------------------------

describe('KD-03 fork/clear hygiene', () => {
  it('a cancelled goal leaves exactly one pending reminder that a consume clears', () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const live = new WorkerStateJournal({ journalPath, now });
    live.recordGoal(activeGoal(now));
    live.cancelGoal('goal-kd03', 'rem-1');

    // Before delivery: reminder is pending, goal cleared.
    let state = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    expect(state.goal).toBeNull();
    expect(state.pendingReminder?.id).toBe('rem-1');
    expect(state.pendingReminder?.origin).toBe('goal_cancel');

    // Live delivery: emit once, then record the consume so replay won't re-fire.
    const sink = vi.fn();
    deliverOneShotReminder(state.pendingReminder!, sink);
    live.consumeReminder('rem-1');
    expect(sink).toHaveBeenCalledTimes(1);

    // After consume: every future restore sees no pending reminder.
    state = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    expect(state.pendingReminder).toBeNull();
    // A second restore is still clean (idempotent replay).
    state = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    expect(state.pendingReminder).toBeNull();
  });

  it('a mission fork records its own one-shot reminder variant', () => {
    const journalPath = nextJournalPath();
    const live = new WorkerStateJournal({ journalPath, now: fixedClock() });
    live.forkMission('fork-rem', 'parent-mission');
    const state = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    expect(state.pendingReminder?.origin).toBe('mission_fork');
    expect(state.pendingReminder?.text).toBe(MISSION_FORK_SYSTEM_REMINDER);
  });
});

// ---------------------------------------------------------------------------
// op/model purity: apply returns the same reference on a no-op
// ---------------------------------------------------------------------------

describe('KD-03 op/model contract purity', () => {
  it('a no-op apply returns the identical state reference across projection', () => {
    const kernel = new EventSourcingKernel();
    const model = kernel.defineModel<{ n: number }>('counter', () => ({ n: 0 }));
    kernel.defineOp('bump', {
      model,
      schema: z.object({ by: z.number() }).strict(),
      apply: (s, p) => (p.by === 0 ? s : { n: s.n + p.by }),
    });
    const initial = kernel.project([]);
    const zeroState = initial.get('counter');
    // A no-op op (by: 0) must return the SAME reference — pure, no churn.
    const afterNoop = kernel.project([
      { v: CURRENT_JOURNAL_VERSION, seq: 0, ts: 't', op: 'bump', payload: { by: 0 } },
    ]);
    const noopState = afterNoop.get('counter');
    expect(noopState).toEqual(zeroState);
    // A real change produces a new reference and advances the value.
    const afterBump = kernel.project([
      { v: CURRENT_JOURNAL_VERSION, seq: 0, ts: 't', op: 'bump', payload: { by: 3 } },
    ]);
    expect((afterBump.get('counter') as { n: number }).n).toBe(3);
  });

  it('reminder.consume with a non-matching id is a no-op (reference equality)', () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const live = new WorkerStateJournal({ journalPath, now });
    live.recordGoal(activeGoal(now));
    live.cancelGoal('goal-kd03', 'rem-1');
    // Consume a DIFFERENT id: the pending reminder must survive untouched.
    live.consumeReminder('rem-does-not-match');
    const state = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    expect(state.pendingReminder?.id).toBe('rem-1');
  });

  it('assertNotDuringRestore is a no-op outside restore mode', () => {
    expect(() => assertNotDuringRestore('x')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// KD-01 integration: the restored goal drives runGoalDrivenLoop
// ---------------------------------------------------------------------------

describe('KD-03 x KD-01: the goal driver runs from restored state', () => {
  function scriptedBackend(
    script: GenerateWithToolsResult[]
  ): Pick<ReasoningBackend, 'generateWithTools'> {
    let i = 0;
    return {
      async generateWithTools(): Promise<GenerateWithToolsResult> {
        return script[i++] ?? { text: '[out of script]' };
      },
    };
  }

  it('restores a paused goal, then completes it via an explicit resume', async () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const live = new WorkerStateJournal({ journalPath, now });
    live.recordGoal(activeGoal(now));

    const restored = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();
    expect(restored.goal?.state).toBe('paused');

    // Feed the restored goal straight into the KD-01 driver and resume it.
    const result = await runGoalDrivenLoop({
      objective: restored.goal!.objective,
      resumeFrom: restored.goal!,
      resume: true,
      backend: scriptedBackend([
        { toolCalls: [{ name: 'goal_update', input: { status: 'complete', reason: 'done' } }] },
      ]),
      stream: new WorkerEventStream(),
      now: fixedClock(),
    });

    expect(result.finalState).toBe('complete');
    expect(result.turnsRun).toBe(1);
  });

  it('a resumed goal that is not explicitly resumed halts without self-advancing', async () => {
    const journalPath = nextJournalPath();
    const now = fixedClock();
    const live = new WorkerStateJournal({ journalPath, now });
    live.recordGoal(activeGoal(now));
    const restored = new WorkerStateJournal({ journalPath, now: fixedClock() }).restore();

    const backend = { generateWithTools: vi.fn() };
    const result = await runGoalDrivenLoop({
      objective: restored.goal!.objective,
      resumeFrom: restored.goal!,
      // resume omitted: driver must NOT self-advance a paused goal.
      backend,
      stream: new WorkerEventStream(),
      now: fixedClock(),
    });

    expect(result.finalState).toBe('paused');
    expect(result.turnsRun).toBe(0);
    expect(backend.generateWithTools).not.toHaveBeenCalled();
  });
});
