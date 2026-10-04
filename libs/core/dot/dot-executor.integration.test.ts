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
import { safeRmSync } from '../secure-io.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import type { DotCharter } from './dot-charter.js';
import {
  checkDotProposalBounds,
  dispatchDotProposals,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import { setDotBudgetThrottleForTests } from './dot-budget.js';
import { runDotExecutorSweep, type DotExecutorPorts } from './dot-executor.js';
import { DOT_INBOX_PATH } from './dot-inbox.js';
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

  it('reaps a claim stranded by an executor crash and completes the item on the next sweep', async () => {
    const created = createWorkItem({
      title: 'Answer it',
      description: 'answer',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: 'dact-crash',
        requested_work_shape: 'task_session',
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
    expect(rows).toMatchObject([{ work_item_id: created.item_id, status: 'done' }]);
    const item = getWorkItem(created.item_id)!;
    expect(item.status).toBe('done');
    expect(item.attempts?.[0]).toMatchObject({ failure_reason: 'lease_expired' });
    expect(p.runGoalTurn).toHaveBeenCalledTimes(1);
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
