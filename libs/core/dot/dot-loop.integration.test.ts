/**
 * The closed organization loop end to end, composed from the real modules
 * (hermetic: tmp state root, work-coordination namespace, injected clock,
 * stub ports): charter with a key result → wake (fenced proposals + memory op +
 * follow-up) → dispatch (auto) → WorkItem → executor sweep → result row +
 * report-back that makes the dot due again → KR moves → outcome judged
 * `improved` after the settle window → autonomy metrics see it; memory and the
 * follow-up persist and the follow-up falls due later.
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonLines } from '../foundation/json.js';
import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { loadDotCharter, type DotCharter } from './dot-charter.js';
import { dotAutonomyMetrics } from './dot-autonomy.js';
import { setDotBudgetThrottleForTests } from './dot-budget.js';
import { dispatchDotProposals, type DotDispatchDeps } from './dot-dispatch.js';
import { runDotExecutorSweep, type DotExecutorPorts } from './dot-executor.js';
import { evaluateDotFollowupsDue, listPendingDotFollowups } from './dot-followups.js';
import { measureDotKeyResults } from './dot-key-results.js';
import { readDotMemory } from './dot-memory.js';
import {
  evaluateDueDotOutcomes,
  readDotOutcomes,
  scheduleDotOutcomeChecks,
} from './dot-outcomes.js';
import { evaluateDotTriggersDue, runDotWake } from './dot-runtime.js';
import { DOT_WORK_RESULTS_FILE, dotStatePath, type DotWorkResultRow } from './dot-state-paths.js';

const TEST_ROOT = 'active/shared/tmp/dot-loop-integration-tests';
const DOT_ID = 'loop-it';

const CHARTER_JSON = {
  kind: 'dot-charter',
  dot_id: DOT_ID,
  version: '1.0.0',
  title: 'Loop IT',
  purpose: 'Closed-loop integration.',
  status: 'active',
  scope: { tier: 'public' },
  goal: {
    statement: 'Keep overdue operations low.',
    budget: { wall_clock_ms_per_wake: 30_000 },
    outcome_settle_minutes: 30,
    key_results: [
      {
        kr_id: 'overdue',
        title: 'Overdue operations',
        metric: { source: 'org_metric', metric: 'overdue_operations' },
        target: 2,
        direction: 'decrease',
        baseline: 8,
        every_s: 60,
      },
    ],
  },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] },
  authority: {
    authority_role: 'infrastructure_sentinel',
    allowed_work_shapes: ['task_session'],
    max_concurrent_delegations: 2,
  },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  memory: { enabled: true },
  followups: { max_pending: 3 },
  runtime: { heartbeat_id: 'dot-loop-it' },
};

const T0 = Date.parse('2026-10-05T09:00:00.000Z');
let clockMs = T0;
const now = () => new Date(clockMs);
const advance = (minutes: number) => {
  clockMs += minutes * 60_000;
};

let charter: DotCharter;
let charterPath: string;
let overdue = 8;

const OPEN = ['backlog', 'ready', 'in_progress', 'blocked', 'review'] as const;
const countOpen = (dotId: string) =>
  listWorkItems({ status: [...OPEN] }).filter((item) => item.metadata?.dot_id === dotId).length;

function autoGate(): AutonomousOpsGateResult {
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

function dispatchDeps(): DotDispatchDeps {
  return {
    rootDir: TEST_ROOT,
    now,
    gate: () => autoGate(),
    route: () => ({
      level: 'none',
      timing: 'digest',
      proceed: true,
      parked: false,
      shadow: false,
      notified: false,
    }),
    createWorkItem: (input) => createWorkItem(input),
    countOpenWorkItems: countOpen,
    listCharters: () => [charter],
    audit: () => {},
    notify: () => true,
    feedback: { onRejection: () => {} },
  };
}

const WAKE_REPLY = [
  'Overdue operations are above target; delegating a clean-up.',
  '```dot-proposals',
  JSON.stringify([
    {
      title: 'Clear overdue operations',
      objective: 'Work through the overdue operations list.',
      work_shape: 'task_session',
      expected_effect: { kr_id: 'overdue', direction: 'decrease' },
    },
  ]),
  '```',
  '```dot-memory',
  JSON.stringify([{ op: 'add_note', text: 'Overdue backlog traced to the nightly import.' }]),
  '```',
  '```dot-followup',
  JSON.stringify([{ delay_minutes: 120, reason: 'Re-check the overdue count.' }]),
  '```',
].join('\n');

function ports(): DotExecutorPorts {
  return {
    runGoalTurn: vi.fn(async () => ({
      turnsRun: 1,
      finalState: 'complete',
      goal: {},
      finalText: 'cleared the overdue list',
    })),
    delegateText: vi.fn(async () => 'n/a'),
    runPipeline: vi.fn(async () => ({ status: 'succeeded' as const, summary: 'ok' })),
  };
}

const krDeps = () => ({
  rootDir: TEST_ROOT,
  now,
  orgMetric: () => overdue,
});

beforeEach(() => {
  clockMs = T0;
  overdue = 8;
  setDotBudgetThrottleForTests(() => 'normal');
  setWorkCoordinationNamespace('dot-loop-integration-test');
  clearWorkCoordinationStore();
  const dir = pathResolver.rootResolve(path.join(TEST_ROOT, 'dots'));
  safeMkdir(dir, { recursive: true });
  charterPath = path.join(dir, `${DOT_ID}.json`);
  safeWriteFile(charterPath, JSON.stringify(CHARTER_JSON, null, 2));
  charter = loadDotCharter(charterPath);
});

afterEach(() => {
  setDotBudgetThrottleForTests(undefined);
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dot closed organization loop', () => {
  it('wake → dispatch → execute → report-back → outcome → autonomy, with memory and follow-up', async () => {
    // KR baseline measured before the wake (the executor snapshots it on the result row).
    const baseline = await measureDotKeyResults(charter, krDeps());
    expect(baseline).toMatchObject([{ kr_id: 'overdue', value: 8 }]);

    // Wake: the cron trigger is due; the stub backend answers with fenced blocks.
    const [due] = evaluateDotTriggersDue(charter, { rootDir: TEST_ROOT, now });
    expect(due?.key).toContain('cron:0 9 * * *');
    const delegateTask = vi.fn(async () => WAKE_REPLY);
    const receipt = await runDotWake(
      { path: charterPath, charter },
      {
        rootDir: TEST_ROOT,
        now,
        trigger: due,
        backend: { delegateTask },
        hasRole: () => true,
        dispatch: (c, proposals) => dispatchDotProposals(c, proposals, dispatchDeps()).records,
      }
    );
    expect(receipt.outcome).toBe('delivered');
    expect(receipt.tool_errors ?? []).toEqual([]);
    expect(receipt.actions).toMatchObject([{ status: 'dispatched' }]);
    const workItemId = receipt.actions![0].work_item_id!;
    expect(getWorkItem(workItemId)?.metadata).toMatchObject({
      dot_id: DOT_ID,
      expected_effect: { kr_id: 'overdue', direction: 'decrease' },
    });
    expect(countOpen(DOT_ID)).toBe(1);

    // Memory and follow-up persisted by the wake tools.
    expect(readDotMemory(charter, { rootDir: TEST_ROOT, now }).notes.map((n) => n.text)).toEqual([
      'Overdue backlog traced to the nightly import.',
    ]);
    expect(listPendingDotFollowups(charter, { rootDir: TEST_ROOT, now })).toHaveLength(1);
    expect(evaluateDotFollowupsDue(charter, { rootDir: TEST_ROOT, now })).toEqual([]);

    // Executor sweep: stub goal turn closes the WorkItem and reports back.
    advance(5);
    const p = ports();
    const rows = await runDotExecutorSweep([{ path: charterPath, charter }], p, {
      rootDir: TEST_ROOT,
      now,
    });
    expect(rows).toMatchObject([{ work_item_id: workItemId, status: 'done', mode: 'goal_turn' }]);
    expect(rows[0].kr_snapshot).toEqual({ overdue: 8 });
    expect(p.runGoalTurn).toHaveBeenCalledTimes(1);
    expect(getWorkItem(workItemId)?.status).toBe('done');
    expect(countOpen(DOT_ID)).toBe(0);
    const results = readJsonLines<DotWorkResultRow>(
      path.join(TEST_ROOT, dotStatePath(charter, DOT_WORK_RESULTS_FILE))
    );
    expect(results).toHaveLength(1);

    // The report-back makes the dot due again (wake:<hash> trigger).
    const reportDue = evaluateDotTriggersDue(charter, { rootDir: TEST_ROOT, now });
    expect(reportDue.some((t) => t.key.startsWith('wake:'))).toBe(true);

    // Outcome: scheduled at completion, not judged before the settle window.
    const scheduled = scheduleDotOutcomeChecks(charter, { rootDir: TEST_ROOT, now });
    expect(scheduled).toMatchObject([{ work_item_id: workItemId }]);
    expect(
      await evaluateDueDotOutcomes(charter, {
        rootDir: TEST_ROOT,
        now,
        measureKrs: async () => ({ overdue }),
      })
    ).toEqual([]);

    // The KR improves; after the settle window the outcome is `improved`.
    overdue = 3;
    advance(31);
    const measured = await measureDotKeyResults(charter, krDeps());
    expect(measured).toMatchObject([{ kr_id: 'overdue', value: 3 }]);
    const outcomes = await evaluateDueDotOutcomes(charter, { rootDir: TEST_ROOT, now });
    expect(outcomes).toMatchObject([
      { work_item_id: workItemId, verdict: 'improved', before: 8, after: 3 },
    ]);
    expect(readDotOutcomes(charter, { rootDir: TEST_ROOT })).toHaveLength(1);

    // Autonomy metrics see the judged outcome.
    const metrics = dotAutonomyMetrics(charter, { rootDir: TEST_ROOT, now });
    expect(metrics.outcomes_judged).toBe(1);
    expect(metrics.outcome_success_rate).toBe(1);
    expect(metrics.regressed_outcomes_30d).toBe(0);

    // The follow-up falls due once its delay has passed.
    advance(90);
    expect(evaluateDotFollowupsDue(charter, { rootDir: TEST_ROOT, now })).toMatchObject([
      { trigger: { kind: 'followup' }, key: expect.stringContaining('followup:') },
    ]);
  });
});
