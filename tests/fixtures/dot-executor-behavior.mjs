/** Isolated executable evaluation. Each invocation is a fresh process; no provider/channel calls. */
import assert from 'node:assert/strict';
import { withExecutionContextAsync } from '@agent/core/authority';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { writeJson, readJsonIfPresent } from '@agent/core/foundation/json';
import {
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  claimWorkItem,
  setWorkCoordinationNamespace,
} from '@agent/core/work-coordination';
import { DOT_STATE_ROOT } from '@agent/core/dot/dot-state-paths';
import { runDotExecutorSweep, dotExecutorStatusSection } from '@agent/core/dot/dot-executor';
import { stubReasoningBackend } from '@agent/core/reasoning-backend';
import { buildDotExecutorPorts } from '../../dist/scripts/dot_executor_step.js';
import { runValidatedSteps } from '../../dist/scripts/pipeline-execution-part-results.js';
const mode = process.argv[2];
const fair = mode.startsWith('fair');
const root =
  'active/shared/tmp/df-process-evaluation/' +
  (fair ? 'fair' : mode === 'cursor' ? 'cursor' : 'timeout');
const scope = {
  rootDir: root,
  throttle: () => 'normal',
  tokenCapReached: () => false,
  appendInbox: () => {},
  audit: () => {},
};
setWorkCoordinationNamespace(
  fair ? 'df-fair-evaluation' : mode === 'cursor' ? 'df-cursor-evaluation' : 'df-timeout-evaluation'
);
function charter(id, budget = 1000) {
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
const loaded = (c) => ({ path: c.dot_id + '.json', charter: c });
const unused = async () => {
  throw new Error('Model call forbidden');
};
function create(id, dot, target) {
  return createWorkItem({
    itemId: id,
    title: id,
    description: 'Synthetic local file effect',
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
await withExecutionContextAsync('infrastructure_sentinel', async () => {
  if (mode === 'fair-init' || mode === 'timeout' || mode === 'cursor') {
    clearWorkCoordinationStore();
    safeRmSync(root, { recursive: true, force: true });
    safeMkdir(root, { recursive: true });
  }
  if (mode === 'cursor') {
    const fixture = process.argv[3];
    const content = {
      syntax: '{',
      null: 'null',
      false: 'false',
      shape: '{"after":42}',
      late: '{"after":"eval-a:accepted"}',
    }[fixture];
    const cursor = root + '/' + DOT_STATE_ROOT + '/executor-schedule.json';
    safeMkdir(root + '/' + DOT_STATE_ROOT, { recursive: true });
    if (fixture === 'directory') {
      safeMkdir(cursor, { recursive: true });
      safeWriteFile(cursor + '/retained.txt', 'retained evidence');
    } else {
      assert.equal(typeof content, 'string', 'Unknown cursor fixture');
      safeWriteFile(cursor, content);
    }
    create('cursor-waiting', 'eval-a', 'service:cursor-isolation');
    const before = getWorkItem('cursor-waiting');
    let ports = 0;
    const effect = async () => {
      ports++;
      safeWriteFile(root + '/effect.txt', 'unexpected execution');
      return { status: 'succeeded', summary: 'Isolated cursor effect' };
    };
    const rows = await runDotExecutorSweep(
      [loaded(charter('eval-a'))],
      {
        runGoalTurn: effect,
        delegateText: effect,
        runPipeline: effect,
      },
      {
        ...scope,
        throttle: () => {
          if (fixture === 'late') safeWriteFile(cursor, '{');
          return 'normal';
        },
      }
    );
    const preserved =
      fixture === 'directory'
        ? safeReadFile(cursor + '/retained.txt') === 'retained evidence'
        : safeReadFile(cursor) === (fixture === 'late' ? '{' : content);
    const after = getWorkItem('cursor-waiting');
    const result = {
      mode,
      fixture,
      pid: process.pid,
      ports,
      effects: Number(safeExistsSync(root + '/effect.txt')),
      attempts: after?.attempts?.length ?? 0,
      cursorPreserved: preserved,
      workItemUnchanged: JSON.stringify(before) === JSON.stringify(after),
      rows: rows.length,
      diagnostic: dotExecutorStatusSection().collect(charter('eval-a'), {
        rootDir: root,
        now: () => new Date(),
      }).execution.scheduling.state,
    };
    process.stdout.write('MEASURE ' + JSON.stringify(result) + '\n');
    if (process.argv.includes('--expect-blocked')) {
      assert.deepEqual(
        { ...result, pid: 0 },
        {
          mode,
          fixture,
          pid: 0,
          ports: 0,
          effects: 0,
          attempts: 0,
          cursorPreserved: true,
          workItemUnchanged: true,
          rows: 0,
          diagnostic: 'blocked',
        }
      );
    }
  } else if (mode === 'fair-init') {
    for (const id of ['eval-a', 'eval-b', 'eval-c'])
      for (let n = 0; n < 6; n++) create(id + '-' + n, id, 'service:' + id + '-' + n);
  } else if (mode === 'fair-sweep') {
    let clock = 0;
    const order = readJsonIfPresent(root + '/order.json') ?? [];
    await runDotExecutorSweep(
      ['eval-a', 'eval-b', 'eval-c'].map((id) => loaded(charter(id))),
      {
        runGoalTurn: unused,
        delegateText: unused,
        async runPipeline(_ref, ctx) {
          order.push(ctx.dot_id);
          safeWriteFile(root + '/' + ctx.work_item_id + '.txt', ctx.dot_id);
          clock += 11;
          return { status: 'succeeded', summary: 'Actual isolated file committed' };
        },
      },
      { ...scope, clock: () => clock, sweepBudgetMs: 10 }
    );
    writeJson(root + '/order.json', order);
    process.stdout.write(
      'MEASURE ' +
        JSON.stringify({
          mode,
          pid: process.pid,
          order,
          attempts: listWorkItems().reduce((n, item) => n + (item.attempts?.length ?? 0), 0),
        }) +
        '\n'
    );
  } else if (mode === 'timeout') {
    const a = charter('eval-a', 25),
      b = charter('eval-b');
    create('late-a', a.dot_id, 'service:isolated-target');
    create('queued-b', b.dot_id, 'service:isolated-target');
    const events = [];
    const ports = (c) =>
      buildDotExecutorPorts(c, {
        backend: stubReasoningBackend,
        async executePipeline(_ref, ctx, _charter, _signal, assertExecutionCurrent) {
          events.push('start:' + ctx.work_item_id);
          if (ctx.work_item_id === 'late-a') {
            await new Promise((resolve) => setTimeout(resolve, 80));
            safeWriteFile(root + '/late.txt', 'late-a');
            events.push('late-write');
            const result = await runValidatedSteps(
              [
                {
                  op: 'system:write_file',
                  params: { path: root + '/continued.txt', content: 'further-effect' },
                },
              ],
              ctx,
              { quiet: true, hasHuman: false, assertExecutionCurrent }
            );
            return {
              status: result.status === 'succeeded' ? 'succeeded' : 'failed',
              summary: 'Synthetic delayed actuator plus actual pipeline continuation',
            };
          }
          safeWriteFile(root + '/conflicting.txt', 'queued-b');
          events.push('conflicting-commit');
          return { status: 'succeeded', summary: 'Conflicting file committed' };
        },
      });
    const first = await runDotExecutorSweep([loaded(a)], ports, scope);
    const second = await runDotExecutorSweep([loaded(b)], ports, scope);
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.stdout.write(
      'MEASURE ' +
        JSON.stringify({
          mode,
          pid: process.pid,
          first: first.map((r) => r.status),
          second: second.map((r) => r.status),
          events,
          lateWrites: Number(safeExistsSync(root + '/late.txt')),
          furtherSteps: Number(safeExistsSync(root + '/continued.txt')),
          conflictingCommits: Number(safeExistsSync(root + '/conflicting.txt')),
          attempts: listWorkItems().map((item) => [item.item_id, item.attempts?.length ?? 0]),
        }) +
        '\n'
    );
  } else if (mode === 'restart-check') {
    let refused = false;
    try {
      claimWorkItem({
        itemId: 'queued-b',
        actorPeerId: 'dot:eval-b',
        purpose: 'Restart check',
        requireNewLease: true,
      });
    } catch {
      refused = true;
    }
    process.stdout.write(
      'MEASURE ' +
        JSON.stringify({
          mode,
          pid: process.pid,
          refused,
          ownership: getWorkItem('late-a')?.effect_ownership?.state,
          attempts: getWorkItem('queued-b')?.attempts?.length ?? 0,
        }) +
        '\n'
    );
  } else throw new Error('Unknown evaluation mode');
});
