/** Actual dispatcher/claim/executor with inert synthetic ports; no ADF/provider/effect authority claim. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotWorkResultRow } from './dot-state-paths.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-dot-result-hook-${randomUUID()}`);
const initialTime = Date.parse('2026-10-31T00:00:00.000Z');
let bootstrap: typeof import('../secure-io.js'), io: typeof import('../secure-io.js');
let executor: typeof import('./dot-executor.js'),
  reports: typeof import('./dot-executor-reports.js');
let dispatch: typeof import('./dot-dispatch.js'), proposals: typeof import('./dot-proposals.js');
let coordination: typeof import('../workforce/work-coordination.js'),
  ledger: typeof import('../workforce/work-coordination-ledger.js');
let store: typeof import('./dot-result-store.js'),
  records: typeof import('./dot-result-records.js');
let projects: typeof import('../project/project-registry.js'),
  state: typeof import('./dot-state-paths.js'),
  authority: typeof import('../authority.js');
let json: typeof import('../foundation/json.js');
let serial = 0;
beforeAll(async () => {
  bootstrap = await import('../secure-io.js');
  bootstrap.safeMkdir(root, { recursive: true });
  const copy = (from: string, to: string): void => {
    if (bootstrap.safeLstat(from).isDirectory()) {
      bootstrap.safeMkdir(to, { recursive: true });
      for (const name of bootstrap.safeReaddir(from))
        copy(path.join(from, name), path.join(to, name));
    } else bootstrap.safeCopyFileSync(from, to);
  };
  for (const name of ['schemas', 'governance', 'orchestration'])
    copy(
      path.join(sourceRoot, 'knowledge/product', name),
      path.join(root, 'knowledge/product', name)
    );
  const policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json'),
    policy = JSON.parse(String(bootstrap.safeReadFile(policyPath, { encoding: 'utf8' })));
  policy.actions.dot_delegate_work.axis_scores = {
    scope: 0,
    reversibility: 0,
    sensitivity: 0,
    confidence: 0,
  };
  bootstrap.safeWriteFile(policyPath, JSON.stringify(policy));
  bootstrap.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  bootstrap.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/result-hook.json'),
    JSON.stringify({
      tenant_slug: 'result-hook',
      display_name: 'Fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_TENANT', 'result-hook');
  vi.stubEnv('SYSTEM_ROLE', '');
  // Exercise the staged real store claim, not production NHI qualification.
  vi.stubEnv('KYBERION_NHI_ACTOR', 'warn');
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(initialTime);
  io = await import('../secure-io.js');
  executor = await import('./dot-executor.js');
  reports = await import('./dot-executor-reports.js');
  dispatch = await import('./dot-dispatch.js');
  proposals = await import('./dot-proposals.js');
  coordination = await import('../workforce/work-coordination.js');
  ledger = await import('../workforce/work-coordination-ledger.js');
  store = await import('./dot-result-store.js');
  records = await import('./dot-result-records.js');
  projects = await import('../project/project-registry.js');
  state = await import('./dot-state-paths.js');
  authority = await import('../authority.js');
  json = await import('../foundation/json.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  coordination?.clearWorkCoordinationNamespace();
  vi.setSystemTime(initialTime);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  bootstrap?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});
function fixture(options: { public?: boolean; shape?: 'pipeline' | 'task_session' } = {}) {
  const id = `result-hook-${++serial}`;
  coordination.setWorkCoordinationNamespace(id);
  if (!options.public)
    projects.saveProjectRecord({
      project_id: id,
      name: id,
      summary: 'Synthetic result hook',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'result-hook',
      organization_id: 'hook-org',
    } as Parameters<typeof projects.saveProjectRecord>[0]);
  const charter: DotCharter = {
    kind: 'dot-charter',
    dot_id: id,
    version: '1.0.0',
    title: id,
    purpose: 'Synthetic result hook',
    status: 'active',
    scope: options.public
      ? { tier: 'public' }
      : {
          tier: 'confidential',
          tenant_slug: 'result-hook',
          organization_id: 'hook-org',
          project_id: id,
        },
    goal: { statement: 'Record synthetic outcome', budget: { wall_clock_ms_per_wake: 15000 } },
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['pipeline', 'task_session'],
      allowed_pipelines: ['pipelines/hook-fixture.json'],
      max_concurrent_delegations: 2,
    },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: id },
  };
  // Public charter setup also uses the permitted fixture scratch path; only confidential needs canonical discovery.
  const charterPath = path.join(
    root,
    options.public ? 'active/shared/tmp/charters' : 'knowledge/confidential/result-hook/dots',
    id + '.json'
  );
  io.safeMkdir(path.dirname(charterPath), { recursive: true });
  io.safeWriteFile(charterPath, JSON.stringify(charter));
  const proposal = proposals.normalizeDotProposal({
    title: 'Synthetic result work',
    objective: 'Keep private body scoped',
    work_shape: options.shape ?? 'pipeline',
    ...(options.shape === 'task_session' ? {} : { pipeline_ref: 'pipelines/hook-fixture.json' }),
    target: 'service:' + id,
    intent: 'apply',
  });
  const action = dispatch.dispatchDotProposals(charter, [proposal], {
    rootDir: root,
    operationKey: id,
    // Trusted fixture admission configuration; the later runtime port can lose this capability.
    taskSessionExecutorAvailable: options.shape === 'task_session',
    now: () => new Date(),
    feedback: { onRejection: vi.fn() },
  }).records[0];
  expect(action.status).toBe('dispatched');
  const item = () => coordination.getWorkItem(action.work_item_id!, { rootDir: root })!;
  const inbox = vi.fn(),
    model = vi.fn(async (): Promise<never> => {
      throw new Error('Model forbidden');
    });
  const file = path.join(root, state.dotStatePath(charter, state.DOT_WORK_RESULTS_FILE));
  const output = path.join(root, 'active/shared/tmp', id, 'effect.txt');
  io.safeMkdir(path.dirname(output), { recursive: true });
  const deps = {
    rootDir: root,
    now: () => new Date(),
    clock: Date.now,
    throttle: () => 'normal' as const,
    tokenCapReached: () => false,
    appendInbox: inbox,
    audit: () => undefined,
  };
  const port = vi.fn(async () => {
    io.safeWriteFile(output, 'fixed synthetic effect');
    return { status: 'succeeded' as const, summary: 'PRIVATE EXECUTION BODY', executedSteps: 1 };
  });
  const run = () =>
    executor.executeDotWorkItem(
      charter,
      item(),
      { runPipeline: port, runGoalTurn: model, delegateText: model },
      deps
    );
  const raw = () =>
    String(io.safeReadFile(file, { encoding: 'utf8' }))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    id,
    charter,
    charterPath,
    action,
    item,
    inbox,
    model,
    file,
    output,
    deps,
    port,
    run,
    raw,
  };
}
function expiredOrphan() {
  const f = fixture(),
    before = f.item();
  const claim = coordination.claimWorkItem({
    itemId: before.item_id,
    expectedVersion: before.version,
    actorPeerId: 'dot:' + f.id,
    actorUserId: 'user:fixture-owner',
    purpose: 'Synthetic orphaned process claim',
    ttlMs: 1000,
    idempotencyKey: f.action.action_ref,
  });
  // The vanished worker may already have affected its synthetic target. No stopped/no-effect proof is invented.
  io.safeWriteFile(f.output, 'possible unobserved synthetic effect');
  vi.setSystemTime(Date.now() + 1000);
  const active = [{ path: f.charterPath, charter: f.charter }];
  return { ...f, claim, active };
}
describe('actual confidential executor producer and report integration', () => {
  it('retains an unknown held actual effect when the next outcome would exceed the retained byte ceiling', async () => {
    const f = fixture();
    const seed: DotWorkResultRow = {
      dot_id: 'retained-dot',
      work_item_id: 'retained-item',
      action_ref: 'retained-action',
      attempt_id: 'retained-run',
      mode: 'pipeline',
      status: 'done',
      summary: 'Isolated retained seed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      report_to_dot_id: 'retained-dot',
    };
    const line = records.dotResultCanonicalJson(seed) + '\n';
    const before = line + ' '.repeat(16 * 1024 * 1024 - Buffer.byteLength(line) - 1) + '\n';
    io.safeMkdir(path.dirname(f.file), { recursive: true });
    io.safeWriteFile(f.file, before);
    await expect(f.run()).rejects.toThrow('retained byte limit');
    expect(f.port).toHaveBeenCalledOnce();
    expect(io.safeExistsSync(f.output)).toBe(true); // A real synthetic effect happened; this is not zero-effect proof.
    expect(f.item()).toMatchObject({ status: 'in_progress', effect_ownership: { state: 'held' } });
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(before);
    expect(f.inbox).not.toHaveBeenCalled();
    expect((await f.run()).status).toBe('skipped');
    expect(f.port).toHaveBeenCalledOnce();
  });
  it('keeps an oversized report marker pending while retaining its durable outcome and refusing effect replay', async () => {
    const f = fixture();
    let retained = '';
    const deps = {
      ...f.deps,
      appendInbox: () => {
        const original = String(io.safeReadFile(f.file, { encoding: 'utf8' }));
        retained = original + ' '.repeat(16 * 1024 * 1024 - Buffer.byteLength(original) - 1) + '\n';
        io.safeWriteFile(f.file, retained);
      },
    };
    const row = await executor.executeDotWorkItem(
      f.charter,
      f.item(),
      { runPipeline: f.port, runGoalTurn: f.model, delegateText: f.model },
      deps
    );
    expect(row.status).toBe('done');
    expect(f.item()).toMatchObject({
      status: 'done',
      effect_ownership: { state: 'settled', settlement: 'completed' },
    });
    expect(
      store.readConfidentialDotResultState(f.charter, { rootDir: root })[0].report_enqueued_at
    ).toBeUndefined();
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(retained);
    expect((await f.run()).status).toBe('skipped');
    expect(f.port).toHaveBeenCalledOnce();
  });
  it('persists its actual post-port outcome, releases the real claim, appends one processed report marker and inhibits replay', async () => {
    const f = fixture(),
      row = await f.run();
    expect(row).toMatchObject({ status: 'done', mode: 'pipeline' });
    expect(f.port).toHaveBeenCalledTimes(1);
    expect(f.inbox).toHaveBeenCalledTimes(1);
    expect(f.item()).toMatchObject({
      status: 'done',
      effect_ownership: { state: 'settled', settlement: 'completed' },
    });
    expect(f.item().lease_id).toBeUndefined();
    expect(f.item().attempts?.at(-1)?.status).toBe('released');
    const events = ledger.withCoordinationRoot(root, () =>
      coordination.listCoordinationEvents({ item_id: f.item().item_id })
    );
    expect(
      events.some(
        (event) =>
          event.event_type === 'item_attempt_released' && event.payload?.run_id === row.attempt_id
      )
    ).toBe(true);
    const raw = f.raw();
    expect(raw).toHaveLength(2);
    expect(raw[0].summary).toContain('PRIVATE EXECUTION BODY');
    expect(raw[1].kind).toBe('dot-result-report-marker');
    const body = reports.readDotWorkResults(f.charter, { rootDir: root });
    expect(body).toHaveLength(1);
    expect(body[0].report_enqueued_at).toBeDefined();
    const minimal = reports.scopedWorkResults(f.charter, {
      ...f.deps,
      resultsCache: new Map([[reports.resultsCacheKey(f.charter), []]]),
    });
    expect(minimal).toHaveLength(1);
    expect(JSON.stringify(minimal)).not.toContain('PRIVATE EXECUTION BODY');
    expect((await f.run()).status).toBe('skipped');
    expect(f.port).toHaveBeenCalledTimes(1);
    expect(f.raw()).toHaveLength(2);
    expect(f.model).not.toHaveBeenCalled();
    reports.reconcileExecutorReports([{ path: f.charterPath, charter: f.charter }], f.deps);
    expect(f.inbox).toHaveBeenCalledTimes(1);
  });
  it('cannot synthesize terminal evidence from a supplied cache before execution', async () => {
    const f = fixture();
    const fake: DotWorkResultRow = {
      dot_id: f.id,
      work_item_id: f.item().item_id,
      action_ref: f.action.action_ref,
      mode: 'pipeline',
      status: 'done',
      summary: 'forged cache',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    expect(
      reports.scopedWorkResults(f.charter, {
        ...f.deps,
        resultsCache: new Map([[reports.resultsCacheKey(f.charter), [fake]]]),
      })
    ).toEqual([]);
    expect((await f.run()).status).toBe('done');
    expect(f.port).toHaveBeenCalledTimes(1);
  });
  it('a post-effect append failure retains the actual claim and ownership with no result or automatic replay', async () => {
    const f = fixture(),
      append = io.safeAppendFileSync;
    vi.spyOn(io, 'safeAppendFileSync').mockImplementation((file, data, options) => {
      if (String(file) === f.file) throw new Error('Injected actual result failure');
      return append(file, data, options);
    });
    await expect(f.run()).rejects.toThrow('Injected actual result failure');
    expect(String(io.safeReadFile(f.output, { encoding: 'utf8' }))).toBe('fixed synthetic effect');
    expect(f.item()).toMatchObject({ status: 'in_progress', effect_ownership: { state: 'held' } });
    expect(f.item().lease_id).toBeTruthy();
    expect(f.inbox).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(store.readConfidentialDotResultState(f.charter, { rootDir: root })).toEqual([]);
    expect((await f.run()).status).toBe('skipped');
    expect(f.port).toHaveBeenCalledTimes(1);
  });
  it('a failed report marker is retried after actual acknowledgement without replaying or duplicating the outcome', async () => {
    const f = fixture(),
      append = io.safeAppendFileSync;
    let fail = true;
    vi.spyOn(io, 'safeAppendFileSync').mockImplementation((file, data, options) => {
      if (String(file) === f.file && String(data).includes('dot-result-report-marker') && fail)
        throw new Error('Marker not stored');
      return append(file, data, options);
    });
    expect((await f.run()).status).toBe('done');
    expect(f.item().status).toBe('done');
    expect(f.raw()).toHaveLength(1);
    expect(f.inbox).toHaveBeenCalledTimes(1);
    fail = false;
    reports.reconcileExecutorReports([{ path: f.charterPath, charter: f.charter }], f.deps);
    expect(f.raw()).toHaveLength(2);
    expect(f.inbox).toHaveBeenCalledTimes(2);
    expect(f.inbox.mock.calls[0][0].idempotency_key).toBe(f.inbox.mock.calls[1][0].idempotency_key);
    reports.reconcileExecutorReports([{ path: f.charterPath, charter: f.charter }], f.deps);
    expect(f.inbox).toHaveBeenCalledTimes(2);
    expect(f.port).toHaveBeenCalledTimes(1);
  });
  it.each(['resolved', 'rejected'] as const)(
    'keeps a %s async-shaped confidential enqueue pending without marking or replaying business work',
    async (outcome) => {
      const f = fixture();
      const asyncEnqueue = vi.fn(() =>
        outcome === 'resolved'
          ? Promise.resolve()
          : Promise.reject(new Error('Injected async enqueue rejection'))
      );
      const row = await executor.executeDotWorkItem(
        f.charter,
        f.item(),
        { runPipeline: f.port, runGoalTurn: f.model, delegateText: f.model },
        { ...f.deps, appendInbox: asyncEnqueue }
      );
      await Promise.resolve();
      expect(row.status).toBe('done');
      expect(row.report_enqueued_at).toBeUndefined();
      expect(f.item().status).toBe('done');
      expect(f.port).toHaveBeenCalledTimes(1);
      expect(asyncEnqueue).toHaveBeenCalledTimes(1);
      expect(f.raw()).toHaveLength(1);
      expect(
        store.readConfidentialDotResultState(f.charter, { rootDir: root })[0].report_enqueued_at
      ).toBeUndefined();
      expect((await f.run()).status).toBe('skipped');
      expect(f.port).toHaveBeenCalledTimes(1);
      expect(f.raw()).toHaveLength(1);
      // A later legitimate synchronous retry can acknowledge the pending report with the same identity.
      reports.reconcileExecutorReports([{ path: f.charterPath, charter: f.charter }], f.deps);
      expect(f.inbox).toHaveBeenCalledTimes(1);
      expect(f.raw()).toHaveLength(2);
      expect(f.port).toHaveBeenCalledTimes(1);
    }
  );
  it('records explicit capability-unavailable suppression without any inbox acknowledgement or wake', async () => {
    const f = fixture({ shape: 'task_session' });
    const row = await executor.executeDotWorkItem(
      f.charter,
      f.item(),
      {
        runPipeline: f.port,
        runGoalTurn: f.model,
        delegateText: f.model,
        taskSessionUnavailable: 'No governed fixture work tools',
      },
      f.deps
    );
    expect(row).toMatchObject({
      status: 'blocked',
      reason_code: 'capability_unavailable',
      report_suppressed: 'capability_unavailable',
    });
    expect(f.inbox).not.toHaveBeenCalled();
    expect(f.port).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
    const raw = f.raw();
    expect(raw).toHaveLength(2);
    expect(raw[1].report_suppressed).toBe('capability_unavailable');
    expect(
      records.projectDotResultRecords(raw, records.dotResultScopeSchema.parse(f.charter.scope))
    ).toHaveLength(1);
  });
  it('preserves the captured outcome when only the persisted charter pauses after its synthetic effect', async () => {
    const f = fixture();
    f.port.mockImplementation(async () => {
      io.safeWriteFile(f.output, 'fixed synthetic effect');
      io.safeWriteFile(
        f.charterPath,
        JSON.stringify({ ...f.charter, status: 'paused', version: '1.0.1' })
      );
      return { status: 'succeeded', summary: 'Paused after port effect', executedSteps: 1 };
    });
    expect((await f.run()).status).toBe('done');
    expect(f.item().status).toBe('done');
    expect(f.raw()).toHaveLength(2);
  });
  it('changed actual ownership after a port effect refuses status publication and retains the unknown claim', async () => {
    const f = fixture();
    f.port.mockImplementation(async () => {
      io.safeWriteFile(f.output, 'fixed synthetic effect');
      io.safeWriteFile(
        f.charterPath,
        JSON.stringify({ ...f.charter, scope: { ...f.charter.scope, project_id: 'other-project' } })
      );
      return { status: 'succeeded', summary: 'Unknown changed scope', executedSteps: 1 };
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.item()).toMatchObject({ status: 'in_progress', effect_ownership: { state: 'held' } });
    expect(f.inbox).not.toHaveBeenCalled();
  });
  it('retains ordinary charter-role body/append denial and marks private proof as unknown rather than absent', async () => {
    const f = fixture();
    await f.run();
    expect(() =>
      authority.withExecutionContext(
        'infrastructure_sentinel',
        () => reports.readDotWorkResults(f.charter, { rootDir: root }),
        undefined,
        'result-hook',
        'hook-org'
      )
    ).toThrow();
    expect(() =>
      authority.withExecutionContext(
        'infrastructure_sentinel',
        () => io.safeAppendFileSync(f.file, 'forged'),
        undefined,
        'result-hook',
        'hook-org'
      )
    ).toThrow();
    const result = reports.scopedWorkResults(f.charter, f.deps)[0],
      item = structuredClone(f.item());
    item.status = 'in_progress';
    item.metadata = {
      ...item.metadata,
      front_desk_execution: { request_id: 'withheld-private-proof' },
    };
    expect(reports.activeTerminalResult(new Map([[item.item_id, result]]), item)).toBe(result);
    expect(reports.resultMatchesAttempt(result, item)).toBe(false);
    delete item.metadata.front_desk_execution;
    item.metadata.dot_executor = { awaiting_approval: true };
    expect(reports.resultMatchesAttempt(result, item)).toBe(false);
  });
  it('public execution keeps its legacy single-row write/rewrite format with no new marker record', async () => {
    const f = fixture({ public: true });
    expect((await f.run()).status).toBe('done');
    const raw = f.raw();
    expect(raw).toHaveLength(1);
    expect(raw[0].report_enqueued_at).toBeDefined();
    expect(raw[0].kind).toBeUndefined();
    expect(f.inbox).toHaveBeenCalledTimes(1);
  });
});

describe('actual expired-lease negative recovery producer', () => {
  it('persists blocked unknown evidence before archiving and never executes the orphan effect again', async () => {
    const f = expiredOrphan();
    const reap = (options: Parameters<typeof coordination.reapExpiredWorkLeases>[0]) => {
      const result = coordination.reapExpiredWorkLeases(options);
      expect(f.item()).toMatchObject({ status: 'ready', effect_ownership: { state: 'held' } });
      expect(f.item().attempts?.at(-1)).toMatchObject({
        run_id: f.claim.item.current_attempt_id,
        status: 'released',
        failure_reason: 'lease_expired',
      });
      const events = ledger.withCoordinationRoot(root, () =>
        coordination.listCoordinationEvents({ item_id: f.item().item_id })
      );
      expect(
        events.some(
          (event) =>
            event.event_type === 'item_attempt_released' &&
            event.payload?.run_id === f.claim.item.current_attempt_id &&
            event.payload?.status === 'released' &&
            event.payload?.failure_reason === 'lease_expired'
        )
      ).toBe(true);
      return result;
    };
    const reaped = executor.reapStrandedDotWorkItems(f.active, { ...f.deps, reap });
    expect(reaped?.recovered.some((item) => item.item_id === f.item().item_id)).toBe(true);
    expect(f.item()).toMatchObject({
      status: 'archived',
      effect_ownership: { state: 'held' },
      metadata: { dot_executor: { status: 'blocked', mode: 'escalated' } },
    });
    expect(f.item().attempts?.at(-1)).toMatchObject({
      run_id: f.claim.item.current_attempt_id,
      // Generic archive finalizes the lifecycle attempt; this is NOT a completed effect.
      status: 'completed',
      failure_reason: 'lease_expired',
    });
    const lease = ledger.withCoordinationRoot(root, () =>
      ledger.currentLeaseRecords().find((value) => value.lease_id === f.claim.lease.lease_id)
    );
    expect(lease?.status).toBe('expired');
    expect(lease?.released_at).toBeUndefined();
    const raw = f.raw();
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({
      status: 'blocked',
      mode: 'escalated',
      attempt_id: f.claim.item.current_attempt_id,
    });
    expect(raw[0].reason_code).toBeUndefined();
    expect(f.inbox).toHaveBeenCalledTimes(1);
    executor.reapStrandedDotWorkItems(f.active, f.deps);
    expect((await f.run()).status).toBe('skipped');
    expect(f.raw()).toHaveLength(2);
    expect(f.inbox).toHaveBeenCalledTimes(1);
    expect(f.port).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
    expect(String(io.safeReadFile(f.output, { encoding: 'utf8' }))).toBe(
      'possible unobserved synthetic effect'
    );
  });
  it('a negative append failure leaves ready unknown ownership until a real-history retry can archive it', () => {
    const f = expiredOrphan(),
      append = io.safeAppendFileSync;
    vi.spyOn(io, 'safeAppendFileSync').mockImplementation((file, data, options) => {
      if (String(file) === f.file) throw new Error('Negative persistence unavailable');
      return append(file, data, options);
    });
    executor.reapStrandedDotWorkItems(f.active, f.deps);
    expect(f.item()).toMatchObject({ status: 'ready', effect_ownership: { state: 'held' } });
    expect(f.inbox).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(store.readConfidentialDotResultState(f.charter, { rootDir: root })).toEqual([]);
    executor.reapStrandedDotWorkItems(f.active, f.deps);
    expect(f.item()).toMatchObject({ status: 'archived', effect_ownership: { state: 'held' } });
    expect(f.raw()).toHaveLength(2);
    expect(f.port).not.toHaveBeenCalled();
  });
  it('durable negative evidence survives archive failure and is adopted without another outcome or effect', () => {
    const f = expiredOrphan();
    let fail = true;
    const update = vi.fn((input: Parameters<typeof coordination.updateWorkItem>[0]) => {
      if (fail) {
        fail = false;
        throw new Error('Archive unavailable');
      }
      return coordination.updateWorkItem(input);
    });
    executor.reapStrandedDotWorkItems(f.active, { ...f.deps, update });
    expect(f.item().status).toBe('ready');
    expect(f.raw()).toHaveLength(2);
    expect(f.inbox).toHaveBeenCalledTimes(1);
    executor.reapStrandedDotWorkItems(f.active, { ...f.deps, update });
    expect(f.item()).toMatchObject({ status: 'archived', effect_ownership: { state: 'held' } });
    expect(f.raw()).toHaveLength(2);
    expect(f.inbox).toHaveBeenCalledTimes(1);
    expect(f.port).not.toHaveBeenCalled();
  });
  it('missing actual expiry evidence remains unsupported rather than manufacturing a recovery lease', () => {
    const f = expiredOrphan();
    const reap = (options: Parameters<typeof coordination.reapExpiredWorkLeases>[0]) => {
      const result = coordination.reapExpiredWorkLeases(options),
        file = ledger.withCoordinationRoot(root, ledger.eventsPath);
      const rows = json
        .readJsonLines<{ event_type: string }>(file)
        .filter((event) => event.event_type !== 'lease_expired');
      io.safeWriteFile(file, rows.map((row) => JSON.stringify(row) + '\n').join(''));
      return result;
    };
    executor.reapStrandedDotWorkItems(f.active, { ...f.deps, reap });
    expect(f.item()).toMatchObject({ status: 'ready', effect_ownership: { state: 'held' } });
    expect(store.readConfidentialDotResultState(f.charter, { rootDir: root })).toEqual([]);
    expect(f.inbox).not.toHaveBeenCalled();
    expect(f.port).not.toHaveBeenCalled();
  });
});
