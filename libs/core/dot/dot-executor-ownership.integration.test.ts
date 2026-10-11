import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { approvalStoreRoots, decideApprovalRequest } from '../governance/approval-store.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-store-paths.js';
import { requestDotWorkItemRelease, applyApprovedDotReleases } from './dot-executor-release.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { runDotExecutorSweep, type DotExecutorPorts } from './dot-executor.js';
import { checkDotArbitration } from './dot-arbitration.js';
import { orderExecutorCharters, recordExecutorTurn } from './dot-executor-scheduling.js';
import type { DotCharter } from './dot-charter.js';

const ROOT = 'active/shared/tmp/dot-executor-ownership-tests';
function charter(id: string, budget = 1_000): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: id,
    version: '1.0.0',
    title: id,
    purpose: 'Isolated evaluation',
    status: 'active',
    scope: { tier: 'public' },
    goal: { statement: 'Evaluate', budget: { wall_clock_ms_per_wake: budget } },
    attention: { triggers: [] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_pipelines: ['pipelines/evaluation.json'],
    },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: id },
  };
}
const loaded = (c: DotCharter) => ({ path: `${c.dot_id}.json`, charter: c });
function item(id: string, dot: string, target: string) {
  return createWorkItem({
    itemId: id,
    title: id,
    description: 'Inert file effect',
    status: 'ready',
    metadata: {
      dot_id: dot,
      action_ref: id,
      requested_work_shape: 'pipeline',
      pipeline_ref: 'pipelines/evaluation.json',
      target,
    },
  });
}
const deps = () => ({
  rootDir: ROOT,
  throttle: () => 'normal' as const,
  tokenCapReached: () => false,
  appendInbox: () => {},
  audit: () => {},
});
const unused = async (): Promise<never> => {
  throw new Error('No model calls permitted');
};
beforeEach(() => {
  setWorkCoordinationNamespace('dot-ownership-evaluation');
  clearWorkCoordinationStore();
  safeMkdir(ROOT, { recursive: true });
});
afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  withExecutionContext('infrastructure_sentinel', () => {
    for (const root of Object.values(approvalStoreRoots()))
      safeRmSync(pathResolver.rootResolve(root + '/' + AUTONOMY_APPROVAL_CHANNEL), {
        recursive: true,
        force: true,
      });
  });
  safeRmSync(ROOT, { recursive: true, force: true });
});

describe('real isolated dot behavior', () => {
  it('requires human reconciliation after the late write before permitting a conflicting real commit', async () => {
    const a = charter('eval-a', 15),
      b = charter('eval-b');
    item('late-a', a.dot_id, 'service:reconciled');
    item('queued-b', b.dot_id, 'service:reconciled');
    const commits: string[] = [];
    const ports: DotExecutorPorts = {
      runGoalTurn: unused,
      delegateText: unused,
      async runPipeline(_ref, ctx) {
        const id = String(ctx.work_item_id);
        if (id === 'late-a') await new Promise((resolve) => setTimeout(resolve, 50));
        safeWriteFile(ROOT + '/reconciled.txt', id);
        commits.push(id);
        return { status: 'succeeded', summary: 'isolated commit' };
      },
    };
    await runDotExecutorSweep([loaded(a)], ports, deps());
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(commits).toEqual(['late-a']);
    expect(getWorkItem('late-a')?.effect_ownership?.state).toBe('held');
    const { request } = requestDotWorkItemRelease(
      a,
      {
        workItemId: 'late-a',
        reason: 'Synthetic adapter returned; late file effect inspected and reconciled',
        by: 'fixture-requester',
      },
      { rootDir: ROOT }
    );
    expect(applyApprovedDotReleases([loaded(a)], deps())).toEqual([]);
    await runDotExecutorSweep([loaded(b)], ports, deps());
    expect(commits).toEqual(['late-a']);
    decideApprovalRequest('mission_controller', {
      channel: request.channel,
      storageChannel: AUTONOMY_APPROVAL_CHANNEL,
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'Synthetic Human Reviewer',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      effectBinding: request.accountability?.effectBinding,
    });
    applyApprovedDotReleases([loaded(a)], deps());
    expect(getWorkItem('late-a')?.effect_ownership).toMatchObject({
      state: 'settled',
      settlement: 'human_verified',
    });
    await runDotExecutorSweep([loaded(b)], ports, deps());
    expect(commits).toEqual(['late-a', 'queued-b']);
    expect(safeReadFile(ROOT + '/reconciled.txt', { encoding: 'utf8' })).toBe('queued-b');
  });
  it('allows only one real effect when overlapping sweeps race for the same item', async () => {
    const c = charter('eval-a');
    item('only', c.dot_id, 'service:one');
    let commits = 0;
    const ports: DotExecutorPorts = {
      runGoalTurn: unused,
      delegateText: unused,
      async runPipeline() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        safeWriteFile(ROOT + '/race.txt', 'one');
        commits++;
        return { status: 'succeeded', summary: 'committed' };
      },
    };
    await Promise.all([
      runDotExecutorSweep([loaded(c)], ports, deps()),
      runDotExecutorSweep([loaded(c)], ports, deps()),
    ]);
    expect(commits).toBe(1);
    expect(getWorkItem('only')?.attempts).toHaveLength(1);
  });
  it('retains the successor when membership changes and does not reset after removed identity', () => {
    const a = charter('eval-a'),
      b = charter('eval-b'),
      c = charter('eval-c');
    recordExecutorTurn(a, ROOT);
    expect(orderExecutorCharters([loaded(a), loaded(c), loaded(b)], ROOT)[0].charter.dot_id).toBe(
      'eval-b'
    );
    recordExecutorTurn(b, ROOT);
    expect(orderExecutorCharters([loaded(a), loaded(c)], ROOT)[0].charter.dot_id).toBe('eval-c');
  });
  it.each([false, true])(
    'retains timed-out ownership against queued work and new proposals (same dot: %s)',
    async (sameDot) => {
      const a = charter('eval-a', 15);
      const b = sameDot ? a : charter('eval-b');
      b.team = { priority: 100, owns: ['service:isolated-evaluation'] };
      const target = 'service:isolated-evaluation';
      item('late-a', a.dot_id, target);
      item('queued-b', b.dot_id, target);
      const events: string[] = [];
      const ports: DotExecutorPorts = {
        runGoalTurn: unused,
        delegateText: unused,
        async runPipeline(_ref, context) {
          const id = String(context.work_item_id);
          events.push(`start:${id}`);
          if (id === 'late-a') await new Promise((resolve) => setTimeout(resolve, 65));
          safeWriteFile(`${ROOT}/effect.txt`, id);
          events.push(`commit:${id}`);
          return { status: 'succeeded', summary: 'Actual isolated file written' };
        },
      };
      const first = await runDotExecutorSweep([loaded(a)], ports, deps());
      updateWorkItem({ itemId: 'queued-b', priority: 'urgent' });
      const next = await runDotExecutorSweep([loaded(b)], ports, deps());
      const verdict = checkDotArbitration(
        b,
        {
          action_id: 'dot_delegate_work',
          title: 'Conflicting new work',
          objective: 'Write same target',
          work_shape: 'pipeline',
          pipeline_ref: 'pipelines/evaluation.json',
          target,
        },
        { rootDir: ROOT, now: () => new Date() },
        {
          listCharters: () => [a, b],
          // The real WorkItem store is isolated by namespace, separate from dot state.
          listWorkItems: () => listWorkItems(),
        } as Parameters<typeof checkDotArbitration>[3]
      );
      await new Promise((resolve) => setTimeout(resolve, 85));
      process.stdout.write(
        `DOT_BEHAVIOR ${JSON.stringify({ sameDot, events, first: first.map((x) => x.status), next: next.map((x) => x.status), newProposalAllowed: verdict.ok === true, attempts: listWorkItems().map((x) => [x.item_id, x.attempts?.length ?? 0]), finalContent: safeReadFile(`${ROOT}/effect.txt`, { encoding: 'utf8' }) })}\n`
      );
      expect.soft(first[0].status).toBe('blocked');
      expect.soft(events.filter((x) => x === 'commit:late-a')).toHaveLength(1);
      expect.soft(events.filter((x) => x === 'commit:queued-b')).toHaveLength(0);
      expect.soft(getWorkItem('queued-b')?.attempts ?? []).toHaveLength(0);
      expect.soft(verdict.ok).toBe(false);
    }
  );

  it('gives each continuously eligible dot a turn within three budgeted sweeps', async () => {
    const active = ['eval-a', 'eval-b', 'eval-c'].map((id) => loaded(charter(id)));
    for (const { charter: c } of active)
      for (let n = 0; n < 6; n++) item(`${c.dot_id}-${n}`, c.dot_id, `service:${c.dot_id}-${n}`);
    const order: string[] = [];
    let clock = 0;
    const ports: DotExecutorPorts = {
      runGoalTurn: unused,
      delegateText: unused,
      async runPipeline(_ref, ctx) {
        order.push(String(ctx.dot_id));
        safeWriteFile(`${ROOT}/${ctx.work_item_id}.txt`, String(ctx.dot_id));
        clock += 11;
        return { status: 'succeeded', summary: 'File committed' };
      },
    };
    for (let sweep = 0; sweep < 6; sweep++)
      await runDotExecutorSweep(active, ports, {
        ...deps(),
        clock: () => clock,
        sweepBudgetMs: 10,
      });
    process.stdout.write(
      `DOT_FAIRNESS ${JSON.stringify({ order, attempts: listWorkItems().reduce((n, x) => n + (x.attempts?.length ?? 0), 0) })}\n`
    );
    expect(new Set(order.slice(0, 3)).size).toBe(3);
    expect(new Set(order.slice(3, 6)).size).toBe(3);
    expect(listWorkItems().every((x) => (x.attempts?.length ?? 0) <= 1)).toBe(true);
  });
});
