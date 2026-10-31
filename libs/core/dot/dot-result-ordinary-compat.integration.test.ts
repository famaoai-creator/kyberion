/** Existing ordinary authority remains independent from the narrow result capability. Synthetic ports only. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotWorkResultRow } from './dot-state-paths.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-result-ordinary-${randomUUID()}`);
let bootstrap: typeof import('../secure-io.js'), io: typeof import('../secure-io.js');
let reports: typeof import('./dot-executor-reports.js'),
  executor: typeof import('./dot-executor.js');
let proposals: typeof import('./dot-proposals.js'), dispatch: typeof import('./dot-dispatch.js');
let coordination: typeof import('../workforce/work-coordination.js');
let records: typeof import('./dot-result-records.js'), state: typeof import('./dot-state-paths.js');
let authority: typeof import('../authority.js'), guard: typeof import('../tier-guard.js');
let projects: typeof import('../project/project-registry.js');
let serial = 0;
const ownedResultFiles = new Set<string>();
beforeAll(async () => {
  bootstrap = await import('../secure-io.js');
  const copy = (from: string, to: string): void => {
    if (bootstrap.safeLstat(from).isDirectory()) {
      bootstrap.safeMkdir(to, { recursive: true });
      for (const entry of bootstrap.safeReaddir(from))
        copy(path.join(from, entry), path.join(to, entry));
    } else bootstrap.safeCopyFileSync(from, to);
  };
  for (const name of ['schemas', 'governance', 'orchestration'])
    copy(
      path.join(sourceRoot, 'knowledge/product', name),
      path.join(root, 'knowledge/product', name)
    );
  const policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json');
  const policy = JSON.parse(String(bootstrap.safeReadFile(policyPath, { encoding: 'utf8' })));
  policy.actions.dot_delegate_work.axis_scores = {
    scope: 0,
    reversibility: 0,
    sensitivity: 0,
    confidence: 0,
  };
  bootstrap.safeWriteFile(policyPath, JSON.stringify(policy));
  bootstrap.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  bootstrap.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/ordinary-compat.json'),
    JSON.stringify({
      tenant_slug: 'ordinary-compat',
      display_name: 'Fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_TENANT', 'ordinary-compat');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_NHI_ACTOR', 'warn');
  vi.resetModules();
  io = await import('../secure-io.js');
  reports = await import('./dot-executor-reports.js');
  executor = await import('./dot-executor.js');
  proposals = await import('./dot-proposals.js');
  dispatch = await import('./dot-dispatch.js');
  coordination = await import('../workforce/work-coordination.js');
  records = await import('./dot-result-records.js');
  state = await import('./dot-state-paths.js');
  authority = await import('../authority.js');
  guard = await import('../tier-guard.js');
  projects = await import('../project/project-registry.js');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  coordination?.clearWorkCoordinationNamespace();
  for (const file of ownedResultFiles) io.safeRmSync(file, { force: true });
  ownedResultFiles.clear();
});
afterAll(() => {
  vi.unstubAllEnvs();
  bootstrap?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});
function fixture(role: 'ecosystem_architect' | 'infrastructure_sentinel' = 'ecosystem_architect') {
  const id = `ordinary-${++serial}`;
  coordination.setWorkCoordinationNamespace(id);
  projects.saveProjectRecord({
    project_id: id,
    name: id,
    summary: 'Isolated result compatibility',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'ordinary-compat',
    organization_id: 'compat-org',
  } as Parameters<typeof projects.saveProjectRecord>[0]);
  const charter: DotCharter = {
    kind: 'dot-charter',
    dot_id: id,
    version: '1.0.0',
    title: id,
    purpose: 'Ordinary confidential result compatibility',
    status: 'active',
    scope: {
      tier: 'confidential',
      tenant_slug: 'ordinary-compat',
      organization_id: 'compat-org',
      project_id: id,
    },
    goal: {
      statement: 'Preserve existing result authority',
      budget: { wall_clock_ms_per_wake: 15000 },
    },
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
    authority: {
      authority_role: role,
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: ['pipelines/ordinary-fixture.json'],
      max_concurrent_delegations: 2,
    },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: id },
  };
  const charterFile = path.join(root, 'knowledge/confidential/ordinary-compat/dots', id + '.json');
  io.safeMkdir(path.dirname(charterFile), { recursive: true });
  io.safeWriteFile(charterFile, JSON.stringify(charter));
  const action = dispatch.dispatchDotProposals(
    charter,
    [
      proposals.normalizeDotProposal({
        title: 'Ordinary result',
        objective: 'Retain full protected evidence',
        work_shape: 'pipeline',
        pipeline_ref: 'pipelines/ordinary-fixture.json',
        target: 'service:' + id,
        intent: 'apply',
      }),
    ],
    { rootDir: root, operationKey: id, feedback: { onRejection: vi.fn() } }
  ).records[0];
  expect(action.status).toBe('dispatched');
  const file = path.join(root, state.dotStatePath(charter, state.DOT_WORK_RESULTS_FILE));
  ownedResultFiles.add(file);
  const deps = {
    rootDir: root,
    now: () => new Date(),
    clock: Date.now,
    throttle: () => 'normal' as const,
    tokenCapReached: () => false,
    appendInbox: vi.fn(),
    audit: () => undefined,
  };
  const item = () => coordination.getWorkItem(action.work_item_id!, { rootDir: root })!;
  const ordinary = <T>(fn: () => T) =>
    authority.withExecutionContext(role, fn, undefined, charter.scope.tenant_slug);
  const row = (overrides: Partial<DotWorkResultRow> = {}): DotWorkResultRow => ({
    dot_id: id,
    work_item_id: item().item_id,
    action_ref: action.action_ref,
    attempt_id: 'run-' + id,
    mode: 'pipeline',
    status: 'done',
    summary: 'PRIVATE CONTINUATION EVIDENCE',
    started_at: '2026-10-31T00:00:00.000Z',
    completed_at: '2026-10-31T00:00:01.000Z',
    report_to_dot_id: id,
    ...overrides,
  });
  return { id, charter, charterFile, action, file, deps, item, ordinary, row };
}
describe('ordinary confidential result authority compatibility', () => {
  it('records the actual continuation entrypoint with a real claim and retains its full terminal evidence', () => {
    const f = fixture();
    const before = f.item();
    const claim = coordination.claimWorkItem({
      itemId: before.item_id,
      expectedVersion: before.version,
      actorPeerId: 'dot:' + f.id,
      purpose: 'Synthetic authorized continuation callback',
      ttlMs: 1000,
      idempotencyKey: f.action.action_ref,
    });
    const row = executor.recordDotPipelineContinuation(
      f.charter,
      claim.item,
      { runId: 'pipeline-' + f.id, succeeded: true },
      f.deps
    );
    expect(row.attempt_id).toBe(claim.item.current_attempt_id);
    expect(reports.scopedWorkResults(f.charter, f.deps)).toContainEqual(row);
    expect(reports.resultMatchesAttempt(row, claim.item)).toBe(true);
  });
  it('preserves the historical continuation entrypoint without inventing an absent attempt', () => {
    const f = fixture();
    expect(f.item().current_attempt_id).toBeUndefined();
    const row = executor.recordDotPipelineContinuation(
      f.charter,
      f.item(),
      { runId: 'legacy-' + f.id, succeeded: false },
      f.deps
    );
    expect(row.attempt_id).toBeUndefined();
    expect(reports.scopedWorkResults(f.charter, f.deps)).toContainEqual(
      JSON.parse(JSON.stringify(row))
    );
    expect(reports.markReportEnqueued(f.charter, row, f.id, f.deps).attempt_id).toBeUndefined();
  });
  it('runs the actual ordinary-role expired-lease reaper and quarantines uncertain effects with durable evidence', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-01T00:00:00.000Z'));
    const f = fixture(),
      before = f.item();
    const claim = coordination.claimWorkItem({
      itemId: before.item_id,
      expectedVersion: before.version,
      actorPeerId: 'dot:' + f.id,
      purpose: 'Synthetic orphan',
      ttlMs: 1000,
      idempotencyKey: f.action.action_ref,
    });
    vi.setSystemTime(Date.now() + 1000);
    const result = executor.reapStrandedDotWorkItems(
      [{ path: f.charterFile, charter: f.charter }],
      f.deps
    );
    expect(result?.recovered.some((item) => item.item_id === before.item_id)).toBe(true);
    expect(f.item()).toMatchObject({
      status: 'archived',
      effect_ownership: { state: 'held' },
      metadata: { dot_executor: { status: 'blocked' } },
    });
    expect(reports.scopedWorkResults(f.charter, f.deps)).toContainEqual(
      expect.objectContaining({
        attempt_id: claim.item.current_attempt_id,
        status: 'blocked',
        mode: 'escalated',
      })
    );
  });
  it('preserves actual executor results and full protected continuation evidence for an already-authorized role', async () => {
    const f = fixture();
    expect(f.ordinary(() => guard.validateReadPermission(f.file).allowed)).toBe(true);
    expect(f.ordinary(() => guard.validateWritePermission(f.file, 'append').allowed)).toBe(true);
    const port = vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: 'PRIVATE ACTUAL EXECUTOR RESULT',
      executedSteps: 1,
    }));
    const result = await executor.executeDotWorkItem(
      f.charter,
      f.item(),
      { runPipeline: port, runGoalTurn: vi.fn(), delegateText: vi.fn() },
      f.deps
    );
    expect(result.status).toBe('done');
    expect(port).toHaveBeenCalledOnce();
    const continuation = f.row({ work_item_id: 'continuation-' + f.id, awaiting_approval: true });
    reports.appendWorkResult(f.charter, continuation, f.deps);
    const loaded = reports.scopedWorkResults(f.charter, {
      ...f.deps,
      resultsCache: new Map([[reports.resultsCacheKey(f.charter), []]]),
    });
    expect(loaded.find((entry) => entry.work_item_id === continuation.work_item_id)).toEqual(
      continuation
    );
    expect(
      reports.resultMatchesAttempt(continuation, {
        ...f.item(),
        status: 'in_progress',
        current_attempt_id: continuation.attempt_id,
        metadata: { ...f.item().metadata, dot_executor: { awaiting_approval: true } },
      })
    ).toBe(true);
  });
  it('retains denied worker minimal UNKNOWN and refuses unsupported continuation persistence', async () => {
    const f = fixture('infrastructure_sentinel');
    expect(f.ordinary(() => guard.validateReadPermission(f.file).allowed)).toBe(false);
    const port = vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: 'PRIVATE CAP RESULT',
      executedSteps: 1,
    }));
    expect(
      (
        await executor.executeDotWorkItem(
          f.charter,
          f.item(),
          { runPipeline: port, runGoalTurn: vi.fn(), delegateText: vi.fn() },
          f.deps
        )
      ).status
    ).toBe('done');
    const minimal = reports.scopedWorkResults(f.charter, f.deps)[0];
    expect(minimal.summary).toBe('[protected result body withheld]');
    expect(
      reports.resultMatchesAttempt(minimal, {
        ...f.item(),
        status: 'in_progress',
        current_attempt_id: minimal.attempt_id,
        metadata: { ...f.item().metadata, dot_executor: { awaiting_approval: true } },
      })
    ).toBe(false);
    expect(() => reports.appendWorkResult(f.charter, f.row(), f.deps)).toThrow();
    expect(() => f.ordinary(() => io.safeReadFile(f.file))).toThrow(
      /\[SECURITY\] Read access denied.*Organization Confidential: Higher tier required\./
    );
  });
  it('updates only one historical unmarked line while preserving another DOT immutable original and marker bytes', () => {
    const f = fixture();
    const modern = f.row({
      dot_id: 'another-dot',
      work_item_id: 'another-item',
      action_ref: 'another-action',
      report_to_dot_id: 'another-dot',
    });
    const marker = records.createDotReportMarker({
      row: modern,
      scope: records.dotResultScopeSchema.parse(f.charter.scope),
      reportTo: 'another-dot',
      enqueuedAt: '2026-10-31T00:00:02.000Z',
    });
    const legacy = f.row();
    delete legacy.attempt_id;
    const suffix = '  ' + JSON.stringify(modern) + '\r\n' + JSON.stringify(marker) + '\n\n';
    io.safeMkdir(path.dirname(f.file), { recursive: true });
    io.safeWriteFile(f.file, JSON.stringify(legacy) + '\r\n' + suffix);
    const marked = reports.markReportEnqueued(f.charter, legacy, f.id, f.deps);
    expect(marked.attempt_id).toBeUndefined();
    expect(marked.report_enqueued_at).toBeTruthy();
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' })).endsWith(suffix)).toBe(true);
    expect(reports.readDotWorkResults(f.charter, f.deps)).toHaveLength(1);
    const once = String(io.safeReadFile(f.file, { encoding: 'utf8' }));
    reports.markReportEnqueued(f.charter, legacy, f.id, f.deps);
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(once);
  });
  it('appends modern report metadata without changing original bytes and adopts the first marker', () => {
    const f = fixture(),
      row = f.row();
    const raw = JSON.stringify(row) + '\r\n';
    io.safeMkdir(path.dirname(f.file), { recursive: true });
    io.safeWriteFile(f.file, raw);
    const marked = reports.markReportEnqueued(f.charter, row, f.id, f.deps);
    expect(marked.report_enqueued_at).toBeTruthy();
    const once = String(io.safeReadFile(f.file, { encoding: 'utf8' }));
    expect(once.startsWith(raw)).toBe(true);
    reports.markReportEnqueued(f.charter, row, f.id, f.deps);
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(once);
    expect(reports.readDotWorkResults(f.charter, f.deps)).toHaveLength(1);
  });
  it('does not fall back to capability after an allowed permission probe meets actual I/O denial', () => {
    const f = fixture('infrastructure_sentinel');
    vi.spyOn(guard, 'validateWritePermission').mockReturnValueOnce({ allowed: true });
    expect(() => reports.appendWorkResult(f.charter, f.row(), f.deps)).toThrow();
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
  it('refuses ambiguous and corrupt mixed journals without changing bytes', () => {
    const f = fixture(),
      row = f.row();
    delete row.attempt_id;
    io.safeMkdir(path.dirname(f.file), { recursive: true });
    for (const raw of [
      JSON.stringify(row) + '\n' + JSON.stringify(row) + '\n',
      JSON.stringify(row) + '\n{broken}\n',
    ]) {
      io.safeWriteFile(f.file, raw);
      expect(() => reports.markReportEnqueued(f.charter, row, f.id, f.deps)).toThrow();
      expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(raw);
    }
  });
});
