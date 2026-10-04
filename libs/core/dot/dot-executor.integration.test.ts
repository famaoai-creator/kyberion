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
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import {
  approvalStoreRoots,
  decideApprovalRequest,
  loadApprovalRequest,
} from '../governance/approval-store.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
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
import {
  readDotWorkResults,
  applyApprovedDotReleases,
  DOT_RELEASE_EXPIRY_MINUTES,
  requestDotWorkItemRelease,
  runDotExecutorSweep,
  type DotExecutorPorts,
} from './dot-executor.js';
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
    allowed_work_shapes: ['direct_reply', 'pipeline'],
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
    work_shape: 'direct_reply',
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
  withExecutionContext('infrastructure_sentinel', () => {
    for (const root of Object.values(approvalStoreRoots())) {
      const dir = pathResolver.rootResolve(`${root}/${AUTONOMY_APPROVAL_CHANNEL}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
  });
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

  async function quarantined(actionRef: string) {
    const created = createWorkItem({
      title: 'Unknown effect',
      description: 'Worker crashed after starting',
      status: 'ready',
      metadata: {
        dot_id: 'exec-it',
        action_ref: actionRef,
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
    expect(await runDotExecutorSweep(LOADED, p, { rootDir: TEST_ROOT })).toEqual([]);
    const item = getWorkItem(created.item_id)!;
    expect(item.status).toBe('archived');
    vi.setSystemTime(Date.now() + 10);
    return { item, p };
  }

  const LOADED = [{ path: 'dots/exec-it.json', charter: CHARTER }];

  function decide(requestId: string, decision: 'approved' | 'rejected') {
    const record = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId)!;
    return decideApprovalRequest('mission_controller', {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId,
      decision,
      decidedBy: 'Ops Lead',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      effectBinding: record.accountability?.effectBinding,
    });
  }

  it('a release request alone changes nothing; a human approval re-attempts under a new attempt id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { item, p } = await quarantined('dact-release');
    const firstAttempt = item.attempts?.at(-1)?.run_id;
    expect(() =>
      requestDotWorkItemRelease(
        CHARTER,
        { workItemId: item.item_id, reason: ' ' },
        { rootDir: TEST_ROOT }
      )
    ).toThrow(/DOT_RELEASE_REASON/);
    const { request, reused } = requestDotWorkItemRelease(
      CHARTER,
      { workItemId: item.item_id, reason: 'checked: no partial deploy', by: 'user:ops-lead' },
      { rootDir: TEST_ROOT }
    );
    expect(reused).toBe(false);
    expect(request).toMatchObject({
      status: 'pending',
      storageChannel: AUTONOMY_APPROVAL_CHANNEL,
      accountability: { finalDecision: 'human_only' },
      details: expect.stringContaining('checked: no partial deploy'),
    });
    expect(request.details).toContain(`work item: ${item.item_id}`);
    expect(request.details).toContain('attempts: 1');
    // Asking again reuses the pending request.
    expect(
      requestDotWorkItemRelease(
        CHARTER,
        { workItemId: item.item_id, reason: 'again' },
        { rootDir: TEST_ROOT }
      )
    ).toMatchObject({ reused: true, request: { id: request.id } });

    // The request alone releases nothing.
    expect(await runDotExecutorSweep(LOADED, p, { rootDir: TEST_ROOT })).toEqual([]);
    expect(getWorkItem(item.item_id)!.status).toBe('archived');
    expect(p.runPipeline).not.toHaveBeenCalled();

    decide(request.id, 'approved');
    vi.setSystemTime(Date.now() + 10);
    const audits: Array<Record<string, unknown>> = [];
    const rows = await runDotExecutorSweep(LOADED, p, {
      rootDir: TEST_ROOT,
      audit: (entry) => void audits.push(entry as never),
    });
    expect(rows).toMatchObject([{ status: 'done', mode: 'pipeline' }]);
    expect(rows[0].attempt_id).toBeDefined();
    expect(rows[0].attempt_id).not.toBe(firstAttempt);
    expect(p.runPipeline).toHaveBeenCalledTimes(1);
    const done = getWorkItem(item.item_id)!;
    expect(done.status).toBe('done');
    // The verifier is the approving human, never the requester's --by.
    expect(done.metadata?.dot_executor).toMatchObject({
      operator_verified_by: 'Ops Lead',
      operator_verified_reason: 'checked: no partial deploy',
      operator_verified_approval_id: request.id,
    });
    expect(audits.find((a) => a.operation === 'dot_work_item_operator_release')).toMatchObject({
      actor: { kind: 'human', id: 'Ops Lead' },
    });
    expect(loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, request.id)?.applyResult).toMatchObject({
      result: 'success',
    });
    // Closed items cannot be released again.
    expect(() =>
      requestDotWorkItemRelease(
        CHARTER,
        { workItemId: item.item_id, reason: 'again' },
        { rootDir: TEST_ROOT }
      )
    ).toThrow(/DOT_RELEASE_DONE/);
  });

  it('a rejected release request never releases', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { item, p } = await quarantined('dact-reject');
    const { request } = requestDotWorkItemRelease(
      CHARTER,
      { workItemId: item.item_id, reason: 'looked fine' },
      { rootDir: TEST_ROOT }
    );
    decide(request.id, 'rejected');
    expect(await runDotExecutorSweep(LOADED, p, { rootDir: TEST_ROOT })).toEqual([]);
    expect(getWorkItem(item.item_id)!.status).toBe('archived');
    expect(p.runPipeline).not.toHaveBeenCalled();
  });

  it('an expired release request cannot be approved and never releases', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { item, p } = await quarantined('dact-expire');
    const { request } = requestDotWorkItemRelease(
      CHARTER,
      { workItemId: item.item_id, reason: 'looked fine' },
      { rootDir: TEST_ROOT }
    );
    vi.setSystemTime(Date.now() + DOT_RELEASE_EXPIRY_MINUTES * 60_000 + 1);
    expect(() => decide(request.id, 'approved')).toThrow(/expired/);
    expect(await runDotExecutorSweep(LOADED, p, { rootDir: TEST_ROOT })).toEqual([]);
    expect(getWorkItem(item.item_id)!.status).toBe('archived');
  });

  it('refuses approved requests not decided by an authenticated human, or for another tenant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { item, p } = await quarantined('dact-forged');
    const { request } = requestDotWorkItemRelease(
      CHARTER,
      { workItemId: item.item_id, reason: 'looked fine' },
      { rootDir: TEST_ROOT }
    );
    const approved = {
      ...request,
      status: 'approved' as const,
      decidedBy: 'someone',
      decidedAt: new Date().toISOString(),
      decidedByType: 'human' as const,
      authenticated: true,
    };
    const forged = [
      { ...approved, id: 'r-agent', decidedByType: 'ai_agent' as const },
      { ...approved, id: 'r-unauth', authenticated: false },
      {
        ...approved,
        id: 'r-veto',
        veto: { windowMinutes: 1 } as never,
      },
      {
        ...approved,
        id: 'r-late',
        decidedAt: new Date(Date.parse(request.expiresAt!) + 1).toISOString(),
      },
      {
        ...approved,
        id: 'r-tenant',
        scope: { tier: 'public', tenant_slug: 'other-tenant', scope_kind: 'tenant' } as never,
      },
    ];
    const settled: Array<[string, string | undefined]> = [];
    const released = applyApprovedDotReleases(LOADED, {
      rootDir: TEST_ROOT,
      audit: () => {},
      listApprovals: () => forged,
      markApplied: (record, applyResult) => {
        settled.push([record.id, applyResult.result]);
        return record;
      },
    });
    expect(released).toEqual([]);
    expect(settled).toEqual(forged.map((record) => [record.id, 'failed']));
    expect(getWorkItem(item.item_id)!.status).toBe('archived');
    expect(await runDotExecutorSweep(LOADED, p, { rootDir: TEST_ROOT })).toEqual([]);
    expect(p.runPipeline).not.toHaveBeenCalled();
  });

  it('refuses a release requested for an item of another tenant', () => {
    const created = createWorkItem({
      title: 'Tenant item',
      description: 'x',
      status: 'archived',
      context: { tenant_slug: 'acme' } as never,
      metadata: { dot_id: 'exec-it', action_ref: 'dact-t', dot_executor: { escalated: true } },
    });
    expect(() =>
      requestDotWorkItemRelease(
        CHARTER,
        { workItemId: created.item_id, reason: 'fine' },
        { rootDir: TEST_ROOT }
      )
    ).toThrow(/DOT_RELEASE_SCOPE/);
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
