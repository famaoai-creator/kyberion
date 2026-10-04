/**
 * Dot executor against the real work-coordination store (hermetic namespace)
 * and the real dispatch path: proposal → WorkItem (with executor metadata) →
 * claim → run → release → result row + report-back, and the delegation cap
 * frees once the dot's items are done.
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonLines } from '../foundation/json.js';
import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import * as secureIo from '../secure-io.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import type { DotCharter } from './dot-charter.js';
import {
  checkDotProposalBounds,
  dispatchDotProposals,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import { setDotBudgetThrottleForTests } from './dot-budget.js';
import { readDotWorkResults, runDotExecutorSweep, type DotExecutorPorts } from './dot-executor.js';
import { appendDotInboxEntry, DOT_INBOX_PATH, type DotInboxEntryInput } from './dot-inbox.js';
import type { DotProposal } from './dot-proposals.js';
import { DOT_EXECUTOR_REPORT_SOURCE } from './dot-runtime.js';
import { DOT_WORK_RESULTS_FILE, dotStatePath, type DotWorkResultRow } from './dot-state-paths.js';

const TEST_ROOT = 'active/shared/tmp/dot-executor-integration-tests';
const OPEN = ['backlog', 'ready', 'in_progress', 'blocked', 'review'] as const;

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'exec-it',
  version: '1.0.0',
  title: 'Executor IT',
  purpose: 'Integration.',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'g', budget: { wall_clock_ms_per_wake: 30_000 } },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
  authority: {
    authority_role: 'infrastructure_sentinel',
    allowed_work_shapes: ['task_session', 'pipeline'],
    allowed_pipelines: ['pipelines/ok.json'],
    max_concurrent_delegations: 2,
  },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-exec-it' },
};

function gate(): AutonomousOpsGateResult {
  return {
    actionId: 'dot_delegate_work',
    decision: 'auto',
    allowed: true,
    score: 0,
    maxScore: 6,
    policyVersion: 'test',
    executionMode: 'apply',
    reason: 'test gate',
    axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
    shadow: false,
    escalations: [],
    highRiskPathMatches: [],
  } as AutonomousOpsGateResult;
}

const countOpen = (dotId: string) =>
  listWorkItems({ status: [...OPEN] }).filter((item) => item.metadata?.dot_id === dotId).length;

function dispatchDeps(): DotDispatchDeps {
  return {
    rootDir: TEST_ROOT,
    gate: () => gate(),
    route: () => ({
      level: 'none',
      timing: 'digest',
      proceed: true,
      parked: false,
      shadow: false,
      notified: false,
    }),
    // Real store (namespaced); counted with dispatch's open-status semantics.
    createWorkItem: (input) => createWorkItem(input),
    countOpenWorkItems: countOpen,
    listCharters: () => [CHARTER],
    audit: () => {},
    notify: () => true,
    feedback: { onRejection: () => {} },
  };
}

const PROPOSALS: DotProposal[] = [
  {
    action_id: 'dot_delegate_work',
    title: 'Run the ok pipeline',
    objective: 'Run it.',
    work_shape: 'pipeline',
    pipeline_ref: 'pipelines/ok.json',
    expected_effect: { kr_id: 'overdue', direction: 'decrease' },
    target: 'service:ops',
    intent: 'apply',
  },
  {
    action_id: 'dot_delegate_work',
    title: 'Answer the runbook question',
    objective: 'Answer it.',
    work_shape: 'task_session',
  },
];

function ports(): DotExecutorPorts {
  return {
    runGoalTurn: vi.fn(async () => ({
      turnsRun: 1,
      finalState: 'complete',
      goal: {},
      finalText: 'answered',
    })),
    delegateText: vi.fn(async () => 'n/a'),
    runPipeline: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'ok' })),
  };
}

beforeEach(() => {
  // Hermetic: the budget floor contributor and executor throttle never read real metrics.
  setDotBudgetThrottleForTests(() => 'normal');
  setWorkCoordinationNamespace('dot-executor-integration-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  vi.useRealTimers();
  setDotBudgetThrottleForTests(undefined);
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot executor end to end', () => {
  it('closes dispatched WorkItems one per sweep, reports back and frees the delegation cap', async () => {
    const { records } = dispatchDotProposals(CHARTER, PROPOSALS, dispatchDeps());
    expect(records.map((r) => r.status)).toEqual(['dispatched', 'dispatched']);
    const created = listWorkItems({}).filter((i) => i.metadata?.dot_id === 'exec-it');
    const pipelineItem = created.find((i) => i.metadata?.requested_work_shape === 'pipeline')!;
    expect(pipelineItem.metadata).toMatchObject({
      pipeline_ref: 'pipelines/ok.json',
      expected_effect: { kr_id: 'overdue', direction: 'decrease' },
      target: 'service:ops',
      intent: 'apply',
    });
    // Cap reached: two open WorkItems.
    const third: DotProposal = { ...PROPOSALS[1], title: 'third', objective: 'third' };
    expect(checkDotProposalBounds(CHARTER, third, dispatchDeps()).ok).toBe(false);

    const p = ports();
    const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
    const sweepDeps = { rootDir: TEST_ROOT };
    const first = await runDotExecutorSweep(loaded, p, sweepDeps);
    expect(first).toHaveLength(1);
    expect(countOpen('exec-it')).toBe(1);
    const second = await runDotExecutorSweep(loaded, p, sweepDeps);
    expect(second).toHaveLength(1);
    expect(await runDotExecutorSweep(loaded, p, sweepDeps)).toEqual([]);

    expect(p.runPipeline).toHaveBeenCalledTimes(1);
    expect(p.runGoalTurn).toHaveBeenCalledTimes(1);
    for (const row of [...first, ...second]) {
      const item = getWorkItem(row.work_item_id)!;
      expect(item.status).toBe('done');
      expect(item.lease_id).toBeUndefined();
      expect(item.attempts?.at(-1)).toMatchObject({ status: 'released' });
    }
    expect(countOpen('exec-it')).toBe(0);
    expect(checkDotProposalBounds(CHARTER, third, dispatchDeps()).ok).toBe(true);

    const rows = readJsonLines<DotWorkResultRow>(
      path.join(TEST_ROOT, dotStatePath(CHARTER, DOT_WORK_RESULTS_FILE))
    );
    expect(rows.map((r) => r.status)).toEqual(['done', 'done']);
    const inbox = readJsonLines<{ dot_id: string; payload: Record<string, unknown> }>(
      path.join(TEST_ROOT, DOT_INBOX_PATH)
    );
    expect(inbox).toHaveLength(2);
    expect(inbox.every((row) => row.payload.report_from === DOT_EXECUTOR_REPORT_SOURCE)).toBe(true);
  });

  it('releases a blocked escalation terminal so the delegation cap frees, and reports it', async () => {
    const cap1: DotCharter = {
      ...CHARTER,
      authority: { ...CHARTER.authority, max_concurrent_delegations: 1 },
    };
    const escalate = createWorkItem({
      title: 'Start a mission',
      description: 'mission-shaped',
      status: 'ready',
      metadata: { dot_id: 'exec-it', action_ref: 'dact-m', requested_work_shape: 'mission' },
    });
    const next: DotProposal = { ...PROPOSALS[1], title: 'next', objective: 'next' };
    expect(checkDotProposalBounds(cap1, next, dispatchDeps()).ok).toBe(false);

    const p = ports();
    const rows = await runDotExecutorSweep([{ path: 'dots/exec-it.json', charter: cap1 }], p, {
      rootDir: TEST_ROOT,
    });
    expect(rows).toMatchObject([
      { work_item_id: escalate.item_id, status: 'blocked', mode: 'escalated' },
    ]);
    const item = getWorkItem(escalate.item_id)!;
    expect(item.status).toBe('archived');
    expect(item.metadata?.dot_executor).toMatchObject({ status: 'blocked', escalated: true });
    expect(countOpen('exec-it')).toBe(0);
    expect(checkDotProposalBounds(cap1, next, dispatchDeps()).ok).toBe(true);
    const inbox = readJsonLines<{ text: string; payload: Record<string, unknown> }>(
      path.join(TEST_ROOT, DOT_INBOX_PATH)
    );
    expect(inbox[0].payload).toMatchObject({ status: 'blocked', escalated: true });
    expect(inbox[0].text).toContain('escalated');
  });

  it('quarantines a stranded read-only-labelled claim because its effects are unverified', async () => {
    const created = createWorkItem({
      title: 'Answer it',
      description: 'answer',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: 'dact-crash',
        requested_work_shape: 'direct_reply',
      },
    });
    // Simulate a crash right after the claim: a short lease that is never released.
    claimWorkItem({
      itemId: created.item_id,
      actorPeerId: 'dot:exec-it',
      purpose: 'dot executor',
      ttlMs: 5,
      idempotencyKey: 'dact-crash',
      expectedVersion: created.version,
    });
    expect(getWorkItem(created.item_id)!.status).toBe('in_progress');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const p = ports();
    const rows = await runDotExecutorSweep([{ path: 'dots/exec-it.json', charter: CHARTER }], p, {
      rootDir: TEST_ROOT,
    });
    expect(rows).toEqual([]);
    const item = getWorkItem(created.item_id)!;
    expect(item.status).toBe('archived');
    expect(item.attempts?.[0]).toMatchObject({ failure_reason: 'lease_expired' });
    expect(p.runGoalTurn).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'never replays a late pipeline effect after timeout (release failure: %s)',
    async (releaseFails) => {
      vi.useFakeTimers();
      const created = createWorkItem({
        title: 'Late effect',
        description: 'Apply a delayed effect',
        status: 'ready',
        metadata: {
          dot_id: 'exec-it',
          action_ref: 'dact-late',
          requested_work_shape: 'pipeline',
          pipeline_ref: 'pipelines/ok.json',
        },
      });
      const charter = {
        ...CHARTER,
        goal: { statement: 'g', budget: { wall_clock_ms_per_wake: 25 } },
      };
      const loaded = [{ path: 'dots/exec-it.json', charter }];
      let effects = 0;
      const p = ports();
      p.runPipeline = vi.fn(
        () =>
          new Promise<{ status: 'succeeded'; summary: string }>((resolve) => {
            // Deliberately ignore AbortSignal, like the real pipeline port.
            setTimeout(() => {
              effects += 1;
              resolve({ status: 'succeeded', summary: 'applied' });
            }, 100);
          })
      );
      const deps = {
        rootDir: TEST_ROOT,
        ...(releaseFails
          ? {
              release: () => {
                throw new Error('release store unavailable');
              },
            }
          : {}),
      };
      const first = runDotExecutorSweep(loaded, p, deps);
      await vi.advanceTimersByTimeAsync(26);
      expect(await first).toMatchObject([
        { status: 'blocked', summary: expect.stringContaining('outcome uncertain') },
      ]);
      expect(effects).toBe(0);
      expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(effects).toBe(1);
      // Exercise the real expired-lease reaper if release failed.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
      expect(getWorkItem(created.item_id)!.status).toBe('archived');
      expect(p.runPipeline).toHaveBeenCalledTimes(1);
      expect(effects).toBe(1);
    }
  );

  it('replays completion evidence after release fails instead of repeating a completed effect', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const created = createWorkItem({
      title: 'One effect',
      description: 'Apply once',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: 'dact-done',
        requested_work_shape: 'pipeline',
        pipeline_ref: 'pipelines/ok.json',
      },
    });
    let effects = 0;
    const p = ports();
    p.runPipeline = vi.fn(async () => {
      effects += 1;
      return { status: 'succeeded' as const, summary: 'applied' };
    });
    const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
    const deps = {
      rootDir: TEST_ROOT,
      release: () => {
        expect(readDotWorkResults(CHARTER, { rootDir: TEST_ROOT })).toMatchObject([
          { work_item_id: created.item_id, status: 'done' },
        ]);
        throw new Error('release store unavailable');
      },
    };
    expect(await runDotExecutorSweep(loaded, p, deps)).toMatchObject([{ status: 'done' }]);
    expect(getWorkItem(created.item_id)!.status).toBe('in_progress');
    vi.setSystemTime(Date.now() + 91_000);
    expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
    expect(getWorkItem(created.item_id)!.status).toBe('done');
    expect(getWorkItem(created.item_id)!.metadata?.replayed).toBe(true);
    expect(effects).toBe(1);
  });

  it.each(['action', 'attempt', 'reopened state'] as const)(
    'quarantines a reused item whose %s conflicts with prior completion evidence',
    async (change) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const created = createWorkItem({
        title: 'Original work',
        description: 'Apply once',
        status: 'ready',
        metadata: {
          dot_id: 'exec-it',
          action_ref: 'dact-original',
          requested_work_shape: 'pipeline',
          pipeline_ref: 'pipelines/ok.json',
        },
      });
      const p = ports();
      const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
      const deps = { rootDir: TEST_ROOT };
      expect(await runDotExecutorSweep(loaded, p, deps)).toMatchObject([{ status: 'done' }]);
      updateWorkItem({
        itemId: created.item_id,
        status: 'ready',
        metadata: {
          ...created.metadata,
          action_ref: change === 'action' ? 'dact-reused' : 'dact-original',
        },
      });
      if (change === 'attempt') {
        claimWorkItem({
          itemId: created.item_id,
          actorPeerId: 'dot:exec-it',
          purpose: 'reused attempt',
          ttlMs: 5,
        });
        vi.setSystemTime(Date.now() + 10);
      }
      expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
      expect(getWorkItem(created.item_id)!.status).toBe('archived');
      expect(getWorkItem(created.item_id)!.metadata?.dot_executor).toMatchObject({
        status: 'blocked',
      });
      expect(readDotWorkResults(CHARTER, deps).at(-1)?.summary).toContain('evidence conflicts');
      expect(p.runPipeline).toHaveBeenCalledTimes(1);
    }
  );

  it('quarantines an expired effect-capable claim without any result evidence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const created = createWorkItem({
      title: 'Unknown effect',
      description: 'Worker crashed after starting',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: 'dact-unknown',
        requested_work_shape: 'pipeline',
        pipeline_ref: 'pipelines/ok.json',
      },
    });
    claimWorkItem({
      itemId: created.item_id,
      actorPeerId: 'dot:exec-it',
      purpose: 'dot executor',
      ttlMs: 5,
    });
    vi.setSystemTime(Date.now() + 10);
    const p = ports();
    const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
    expect(await runDotExecutorSweep(loaded, p, { rootDir: TEST_ROOT })).toEqual([]);
    expect(getWorkItem(created.item_id)!.status).toBe('archived');
    expect(readDotWorkResults(CHARTER, { rootDir: TEST_ROOT })).toMatchObject([
      { status: 'blocked', summary: expect.stringContaining('operator must verify') },
    ]);
    expect(p.runPipeline).not.toHaveBeenCalled();
  });

  it('does not replay an effect when result persistence fails before release', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const created = createWorkItem({
      title: 'Effect before storage error',
      description: 'Apply once',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: 'dact-write-fail',
        requested_work_shape: 'pipeline',
        pipeline_ref: 'pipelines/ok.json',
      },
    });
    const file = path.join(TEST_ROOT, dotStatePath(CHARTER, DOT_WORK_RESULTS_FILE));
    let effects = 0;
    const p = ports();
    p.runPipeline = vi.fn(async () => {
      effects += 1;
      safeMkdir(file, { recursive: true }); // A real result-store write failure after the effect.
      return { status: 'succeeded' as const, summary: 'applied' };
    });
    const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
    expect(await runDotExecutorSweep(loaded, p, { rootDir: TEST_ROOT })).toEqual([]);
    expect(getWorkItem(created.item_id)!.status).toBe('in_progress');
    vi.setSystemTime(Date.now() + 91_000);
    expect(await runDotExecutorSweep(loaded, p, { rootDir: TEST_ROOT })).toEqual([]);
    safeRmSync(file, { recursive: true });
    expect(await runDotExecutorSweep(loaded, p, { rootDir: TEST_ROOT })).toEqual([]);
    expect(getWorkItem(created.item_id)!.status).toBe('archived');
    expect(readDotWorkResults(CHARTER, { rootDir: TEST_ROOT })).toMatchObject([
      { status: 'blocked' },
    ]);
    expect(effects).toBe(1);
  });

  it('keeps a recovered uncertain item unclaimable when archiving fails, then reconciles it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const created = createWorkItem({
      title: 'Crashed pipeline',
      description: 'Unknown outcome',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: 'dact-archive-fail',
        requested_work_shape: 'pipeline',
        pipeline_ref: 'pipelines/ok.json',
      },
    });
    claimWorkItem({
      itemId: created.item_id,
      actorPeerId: 'dot:exec-it',
      purpose: 'dot executor',
      ttlMs: 5,
    });
    vi.setSystemTime(Date.now() + 10);
    const update = vi
      .fn<typeof updateWorkItem>()
      .mockImplementationOnce(() => {
        throw new Error('archive unavailable');
      })
      .mockImplementation(updateWorkItem);
    const p = ports();
    const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
    const appendInbox = vi.fn((input: DotInboxEntryInput) => {
      appendDotInboxEntry(input, { rootDir: TEST_ROOT });
    });
    const deps = { rootDir: TEST_ROOT, update, appendInbox };
    expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
    expect(getWorkItem(created.item_id)!.status).toBe('ready');
    expect(appendInbox).toHaveBeenCalledTimes(1);
    expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toMatchObject([
      { payload: { work_item_id: created.item_id, status: 'blocked', escalated: true } },
    ]);
    expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
    expect(getWorkItem(created.item_id)!.status).toBe('archived');
    expect(appendInbox).toHaveBeenCalledTimes(1);
    expect(p.runPipeline).not.toHaveBeenCalled();
  });

  it.each(['before inbox', 'after inbox', 'report marker', 'release and inbox'] as const)(
    'recovers a completed report after failure at %s without re-executing or duplicating the receipt',
    async (failure) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const created = createWorkItem({
        title: 'Report me once',
        description: 'Apply once',
        status: 'ready',
        metadata: {
          dot_id: 'exec-it',
          action_ref: 'dact-report',
          requested_work_shape: 'pipeline',
          pipeline_ref: 'pipelines/ok.json',
        },
      });
      const p = ports();
      let fail = true;
      const appendInbox = (input: DotInboxEntryInput) => {
        if (fail && (failure === 'before inbox' || failure === 'release and inbox'))
          throw new Error('inbox unavailable');
        appendDotInboxEntry(input, { rootDir: TEST_ROOT });
        if (fail && failure === 'after inbox') throw new Error('receipt response lost');
      };
      const originalWrite = secureIo.safeWriteFile;
      const write = vi
        .spyOn(secureIo, 'safeWriteFile')
        .mockImplementation((file, content, options) => {
          if (fail && failure === 'report marker' && file.endsWith(DOT_WORK_RESULTS_FILE))
            throw new Error('report marker unavailable');
          return originalWrite(file, content, options);
        });
      const deps = {
        rootDir: TEST_ROOT,
        appendInbox,
        ...(failure === 'release and inbox'
          ? {
              release: () => {
                throw new Error('release unavailable');
              },
            }
          : {}),
      };
      const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
      try {
        expect(await runDotExecutorSweep(loaded, p, deps)).toMatchObject([{ status: 'done' }]);
        expect(readDotWorkResults(CHARTER, deps)[0].report_enqueued_at).toBeUndefined();
        fail = false;
        vi.setSystemTime(Date.now() + 91_000);
        expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
        expect(getWorkItem(created.item_id)!.status).toBe('done');
        const rows = readDotWorkResults(CHARTER, deps);
        expect(rows).toHaveLength(1);
        expect(rows[0].report_enqueued_at).toBeDefined();
        expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toHaveLength(1);
        expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
        expect(p.runPipeline).toHaveBeenCalledTimes(1);
        // Retention of the inbox must not cause old terminal results to notify again.
        safeRmSync(`${TEST_ROOT}/${DOT_INBOX_PATH}`);
        expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
        expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toEqual([]);
      } finally {
        write.mockRestore();
      }
    }
  );

  it('recovers an unreported uncertain result after archive success', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const created = createWorkItem({
      title: 'Crashed work',
      description: 'Unknown outcome',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: 'dact-unreported',
        requested_work_shape: 'pipeline',
        pipeline_ref: 'pipelines/ok.json',
      },
    });
    claimWorkItem({
      itemId: created.item_id,
      actorPeerId: 'dot:exec-it',
      purpose: 'executor',
      ttlMs: 5,
    });
    vi.setSystemTime(Date.now() + 10);
    let fail = true;
    const deps = {
      rootDir: TEST_ROOT,
      appendInbox: (input: DotInboxEntryInput) => {
        if (fail) throw new Error('inbox unavailable');
        appendDotInboxEntry(input, { rootDir: TEST_ROOT });
      },
    };
    const loaded = [{ path: 'dots/exec-it.json', charter: CHARTER }];
    const p = ports();
    expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
    expect(getWorkItem(created.item_id)!.status).toBe('archived');
    expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toEqual([]);
    fail = false;
    expect(await runDotExecutorSweep(loaded, p, deps)).toEqual([]);
    expect(readJsonLines(`${TEST_ROOT}/${DOT_INBOX_PATH}`)).toMatchObject([
      { payload: { status: 'blocked', escalated: true, work_item_id: created.item_id } },
    ]);
    expect(readDotWorkResults(CHARTER, deps)[0].report_enqueued_at).toBeDefined();
    expect(p.runPipeline).not.toHaveBeenCalled();
  });

  it('reaps only dot items: a stranded non-dot claim is left alone', async () => {
    const other = createWorkItem({ title: 'not a dot item', description: 'x', status: 'ready' });
    claimWorkItem({ itemId: other.item_id, actorPeerId: 'peer:other', purpose: 'x', ttlMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runDotExecutorSweep([{ path: 'dots/exec-it.json', charter: CHARTER }], ports(), {
      rootDir: TEST_ROOT,
    });
    expect(getWorkItem(other.item_id)!.status).toBe('in_progress');
  });
});
