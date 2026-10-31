/** Actual source stores; origin permits are minted by the test, not claimed as executor integration. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotWorkResultRow } from './dot-state-paths.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-dot-result-${randomUUID()}`);
const time = Date.parse('2026-10-31T00:00:00.000Z');
let bootstrap: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let store: typeof import('./dot-result-store.js');
let origin: typeof import('./dot-result-origin.js');
let records: typeof import('./dot-result-records.js');
let dispatch: typeof import('./dot-dispatch.js');
let proposals: typeof import('./dot-proposals.js');
let coordination: typeof import('../workforce/work-coordination.js');
let ledger: typeof import('../workforce/work-coordination-ledger.js');
let authority: typeof import('../authority.js');
let statePaths: typeof import('./dot-state-paths.js');
let locks: typeof import('../foundation/lock-utils.js');
let projects: typeof import('../project/project-registry.js');
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
    path.join(root, 'knowledge/personal/tenants/result-tenant.json'),
    JSON.stringify({
      tenant_slug: 'result-tenant',
      display_name: 'Fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_TENANT', 'result-tenant');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_NHI_ACTOR', 'warn');
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
  io = await import('../secure-io.js');
  store = await import('./dot-result-store.js');
  origin = await import('./dot-result-origin.js');
  records = await import('./dot-result-records.js');
  dispatch = await import('./dot-dispatch.js');
  proposals = await import('./dot-proposals.js');
  coordination = await import('../workforce/work-coordination.js');
  ledger = await import('../workforce/work-coordination-ledger.js');
  authority = await import('../authority.js');
  statePaths = await import('./dot-state-paths.js');
  locks = await import('../foundation/lock-utils.js');
  projects = await import('../project/project-registry.js');
  json = await import('../foundation/json.js');
  projects.saveProjectRecord({
    project_id: 'result-project',
    name: 'Fixture',
    summary: 'Result boundary',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'result-tenant',
    organization_id: 'result-org',
  } as Parameters<typeof saveProjectRecord>[0]);
});
afterEach(() => {
  vi.restoreAllMocks();
  coordination?.clearWorkCoordinationNamespace();
  vi.setSystemTime(time);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  bootstrap?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});
function fixture(
  options: { namespace?: string; tier?: 'public' | 'confidential'; actorUserId?: string } = {}
) {
  const id = `result-${++serial}`;
  coordination.setWorkCoordinationNamespace(options.namespace ?? id);
  const scope: DotCharter['scope'] =
    options.tier === 'public'
      ? { tier: 'public' }
      : {
          tier: 'confidential',
          tenant_slug: 'result-tenant',
          organization_id: 'result-org',
          project_id: `project-${options.namespace ?? id}`,
        };
  if (scope.tier === 'confidential')
    projects.saveProjectRecord({
      project_id: scope.project_id!,
      name: 'Fixture',
      summary: 'Result boundary',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'result-tenant',
      organization_id: 'result-org',
    } as Parameters<typeof projects.saveProjectRecord>[0]);
  const charter: DotCharter = {
    kind: 'dot-charter',
    dot_id: id,
    version: '1.0.0',
    title: id,
    purpose: 'Fixed synthetic file port',
    status: 'active',
    scope,
    goal: { statement: 'Record result safely', budget: { wall_clock_ms_per_wake: 15000 } },
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: ['pipelines/result-fixture.json'],
      max_concurrent_delegations: 10,
    },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: id },
  };
  const charterPath = path.join(root, 'knowledge/confidential/result-tenant/dots', id + '.json');
  io.safeMkdir(path.dirname(charterPath), { recursive: true });
  io.safeWriteFile(charterPath, JSON.stringify(charter));
  const proposal = proposals.normalizeDotProposal({
    title: 'Record synthetic result',
    objective: 'Persist status only',
    work_shape: 'pipeline',
    pipeline_ref: 'pipelines/result-fixture.json',
    target: 'service:' + id,
    intent: 'apply',
  });
  const action = dispatch.dispatchDotProposals(charter, [proposal], {
    rootDir: root,
    operationKey: id,
    now: () => new Date(),
    feedback: { onRejection: vi.fn() },
  }).records[0];
  expect(action.status).toBe('dispatched');
  const before = coordination.getWorkItem(action.work_item_id!, { rootDir: root })!;
  const claim = coordination.claimWorkItem({
    itemId: before.item_id,
    expectedVersion: before.version,
    actorPeerId: 'dot:' + id,
    ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
    purpose: 'actual result test claim',
    ttlMs: 60000,
    idempotencyKey: id,
  });
  const row: DotWorkResultRow = {
    dot_id: id,
    work_item_id: claim.item.item_id,
    action_ref: action.action_ref,
    attempt_id: claim.item.current_attempt_id!,
    mode: 'pipeline',
    status: 'done',
    summary: 'TENANT PRIVATE BODY',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    tokens_used: 42,
    report_to_dot_id: id,
    kr_snapshot: { private_metric: 99 },
    signal_snapshot: { private_signal: 1 },
  };
  const confidentialScope = records.dotResultScopeSchema.safeParse(scope);
  const mint = (value: DotWorkResultRow = row) => {
    if (!confidentialScope.success) throw new Error('Fixture scope is not confidential');
    return origin.mintDotResultOutcomePermit({
      rootDir: root,
      charter,
      scope: confidentialScope.data,
      row: value,
      phase: 'active_execution',
      leaseId: claim.lease.lease_id,
    });
  };
  const file = path.join(root, statePaths.dotStatePath(charter, statePaths.DOT_WORK_RESULTS_FILE));
  return {
    id,
    charter,
    charterPath,
    row,
    claim,
    before,
    action,
    file,
    mint,
    append: (value: DotWorkResultRow = row, token: unknown = mint(value)) =>
      store.appendConfidentialDotWorkResult(charter, value, token, { rootDir: root }),
    read: () => store.readConfidentialDotResultState(charter, { rootDir: root }),
    item: () => coordination.getWorkItem(before.item_id, { rootDir: root })!,
    marker: () =>
      records.createDotReportMarker({
        row,
        scope: records.dotResultScopeSchema.parse(scope),
        reportTo: id,
        enqueuedAt: new Date().toISOString(),
      }),
  };
}
function negativeFixture(park = false) {
  const f = fixture({ actorUserId: 'user:fixture-owner' });
  vi.setSystemTime(Date.now() + 60000);
  const reaped = coordination.reapExpiredWorkLeases({
    now: new Date().toISOString(),
    maxClaimAttempts: park ? 1 : 5,
  });
  expect(
    [...reaped.recovered, ...reaped.parked].some((item) => item.item_id === f.before.item_id)
  ).toBe(true);
  const row: DotWorkResultRow = {
    dot_id: f.id,
    work_item_id: f.before.item_id,
    action_ref: f.action.action_ref,
    attempt_id: f.claim.item.current_attempt_id!,
    mode: 'escalated',
    status: 'blocked',
    summary: 'Outcome unknown after actual scheduling lease expired',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    report_to_dot_id: f.id,
  };
  const mint = (value: DotWorkResultRow = row) =>
    origin.mintDotResultOutcomePermit({
      rootDir: root,
      charter: f.charter,
      scope: records.dotResultScopeSchema.parse(f.charter.scope),
      row: value,
      phase: 'negative_recovery',
    });
  const append = (value: DotWorkResultRow = row, token: unknown = mint(value)) =>
    store.appendConfidentialDotWorkResult(f.charter, value, token, { rootDir: root });
  return { ...f, negativeRow: row, negativeMint: mint, negativeAppend: append };
}
describe('exact confidential DOT result facade', () => {
  it('appends actual owned claim status and returns only filtered body-free audit fields', () => {
    const f = fixture();
    const first = f.append();
    expect(first).toMatchObject({
      status: 'persisted',
      appended: true,
      result: { dot_id: f.id, status: 'done', attempt_id: f.row.attempt_id },
    });
    expect(f.read()).toEqual([first.result]);
    const text = JSON.stringify(f.read());
    for (const secret of [
      'TENANT PRIVATE BODY',
      'private_metric',
      'private_signal',
      'tokens_used',
      'summary',
      'kr_snapshot',
      'pipeline_run_id',
    ])
      expect(text).not.toContain(secret);
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toContain('TENANT PRIVATE BODY');
    expect(f.item().status).toBe('in_progress');
    expect(f.item().effect_ownership?.state).toBe('held');
    // The facade records a test-minted trusted-module origin; P3c separately tests real executor issuance.
  });
  it.each(['outcome', 'marker'] as const)(
    'separates a valid no-LF original before appending %s',
    (operation) => {
      const f = fixture();
      const original =
        operation === 'marker'
          ? f.row
          : {
              ...f.row,
              dot_id: 'seed-dot',
              work_item_id: 'seed-item',
              action_ref: 'seed-action',
              attempt_id: 'seed-run',
              report_to_dot_id: 'seed-dot',
            };
      // Structural retained-row seed is confined to this isolated store, not claimed as executor provenance.
      const prefix = records.dotResultCanonicalJson(original);
      io.safeMkdir(path.dirname(f.file), { recursive: true });
      io.safeWriteFile(f.file, prefix);
      if (operation === 'outcome') f.append();
      else {
        const marker = f.marker();
        store.appendConfidentialDotReportMarker(
          f.charter,
          marker,
          origin.mintDotReportMarkerPermit({
            rootDir: root,
            charter: f.charter,
            scope: marker.scope,
            marker,
          }),
          { rootDir: root }
        );
      }
      const bytes = String(io.safeReadFile(f.file, { encoding: 'utf8' }));
      expect(bytes.startsWith(prefix + '\n')).toBe(true);
      expect(bytes.trimEnd().split('\n')).toHaveLength(2);
      expect(f.read()).toHaveLength(1);
      expect(f.read()[0].report_enqueued_at).toBe(
        operation === 'marker' ? new Date().toISOString() : undefined
      );
    }
  );
  it.each(['outcome', 'marker'] as const)(
    'bounds the exact serialized UTF-8 size of %s at 16 MiB',
    (operation) => {
      for (const overflow of [false, true]) {
        const f = fixture();
        f.row.summary = 'Retained multibyte outcome: \u00e9\u00e9\u00e9';
        const original =
          operation === 'marker'
            ? f.row
            : {
                ...f.row,
                dot_id: 'seed-dot',
                work_item_id: 'seed-item',
                action_ref: 'seed-action',
                attempt_id: 'seed-run',
                report_to_dot_id: 'seed-dot',
              };
        const value = operation === 'marker' ? f.marker() : f.row;
        const line = records.dotResultCanonicalJson(value) + '\n';
        const originalBytes = records.dotResultCanonicalJson(original) + '\n';
        const padding =
          16 * 1024 * 1024 -
          Buffer.byteLength(line) -
          Buffer.byteLength(originalBytes) +
          (overflow ? 1 : 0);
        const before = originalBytes + ' '.repeat(padding);
        // Whitespace is legal retained JSONL; the fixed private fixture never touches operator data.
        io.safeMkdir(path.dirname(f.file), { recursive: true });
        io.safeWriteFile(f.file, before);
        const append = () =>
          operation === 'outcome'
            ? f.append()
            : store.appendConfidentialDotReportMarker(
                f.charter,
                value as ReturnType<typeof f.marker>,
                origin.mintDotReportMarkerPermit({
                  rootDir: root,
                  charter: f.charter,
                  scope: records.dotResultScopeSchema.parse(f.charter.scope),
                  marker: value as ReturnType<typeof f.marker>,
                }),
                { rootDir: root }
              );
        // End the padding in LF so these assertions isolate the exact resulting-byte ceiling.
        io.safeWriteFile(f.file, before.slice(0, -1) + '\n');
        const retained = String(io.safeReadFile(f.file, { encoding: 'utf8' }));
        if (overflow) {
          expect(append).toThrow('retained byte limit');
          expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(retained);
          expect(f.item()).toMatchObject({
            status: 'in_progress',
            effect_ownership: { state: 'held' },
          });
          expect(f.read()[0]?.report_enqueued_at).toBeUndefined();
        } else {
          expect(append().appended).toBe(true);
          expect(io.safeLstat(f.file).size).toBe(16 * 1024 * 1024);
          expect(f.read()).toHaveLength(1);
        }
      }
    }
  );
  it('rejects a shared-file fingerprint change between the read snapshot and append without writing the outcome', () => {
    const f = fixture();
    const prefix =
      records.dotResultCanonicalJson({
        ...f.row,
        dot_id: 'seed-dot',
        work_item_id: 'seed-item',
        action_ref: 'seed-action',
        attempt_id: 'seed-run',
        report_to_dot_id: 'seed-dot',
      }) + '\n';
    io.safeMkdir(path.dirname(f.file), { recursive: true });
    io.safeWriteFile(f.file, prefix);
    const lstat = io.safeLstat,
      getItem = coordination.getWorkItem;
    let calls = 0,
      snapshotCaptured = false,
      faultHits = 0;
    vi.spyOn(io, 'safeLstat').mockImplementation((file) => {
      const result = lstat(file);
      if (String(file) === f.file && ++calls === 2) snapshotCaptured = true;
      return result;
    });
    vi.spyOn(coordination, 'getWorkItem').mockImplementation((...args) => {
      // The fixture owner changes its isolated journal only after read_state has exited.
      if (snapshotCaptured && faultHits === 0) {
        io.safeWriteFile(f.file, prefix + '\n');
        faultHits += 1;
      }
      return getItem(...args);
    });
    expect(() => f.append()).toThrow('changed before append');
    expect(faultHits).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(prefix + '\n');
    expect(f.item()).toMatchObject({ status: 'in_progress', effect_ownership: { state: 'held' } });
  });
  it('same outcome is idempotent with another genuine permit; replay and conflicting outcome are rejected', () => {
    const f = fixture(),
      token = f.mint();
    f.append(f.row, token);
    const bytes = String(io.safeReadFile(f.file, { encoding: 'utf8' }));
    expect(() => f.append(f.row, token)).toThrow();
    expect(f.append().appended).toBe(false);
    expect(() => f.append({ ...f.row, summary: 'Changed outcome' })).toThrow('Conflicting');
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(bytes);
  });
  it('appends and projects report markers without replacing original bytes or duplicating results', () => {
    const f = fixture();
    f.append();
    const before = String(io.safeReadFile(f.file, { encoding: 'utf8' }));
    const marker = f.marker(),
      scope = records.dotResultScopeSchema.parse(f.charter.scope);
    const mint = () =>
      origin.mintDotReportMarkerPermit({ rootDir: root, charter: f.charter, scope, marker });
    const result = store.appendConfidentialDotReportMarker(f.charter, marker, mint(), {
      rootDir: root,
    });
    expect(result.appended).toBe(true);
    expect(f.read()).toHaveLength(1);
    expect(f.read()[0].report_enqueued_at).toBe(marker.report_enqueued_at);
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' })).startsWith(before)).toBe(true);
    expect(
      store.appendConfidentialDotReportMarker(f.charter, marker, mint(), { rootDir: root }).appended
    ).toBe(false);
    vi.setSystemTime(time + 1000);
    const later = { ...marker, report_enqueued_at: new Date().toISOString() };
    const laterPermit = origin.mintDotReportMarkerPermit({
      rootDir: root,
      charter: f.charter,
      scope,
      marker: later,
    });
    expect(
      store.appendConfidentialDotReportMarker(f.charter, later, laterPermit, { rootDir: root })
        .result.report_enqueued_at
    ).toBe(marker.report_enqueued_at);
    const suppressed = { ...later, report_suppressed: 'capability_unavailable' as const };
    expect(() =>
      store.appendConfidentialDotReportMarker(
        f.charter,
        suppressed,
        origin.mintDotReportMarkerPermit({
          rootDir: root,
          charter: f.charter,
          scope,
          marker: suppressed,
        }),
        { rootDir: root }
      )
    ).toThrow();
    const raw = String(io.safeReadFile(f.file, { encoding: 'utf8' }))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(raw).toHaveLength(2);
    expect(raw.filter((row) => row.tokens_used === 42)).toHaveLength(1);
  });
  it('filters two DOTs sharing the exact file and refuses a marker aimed at the other DOT', () => {
    const namespace = 'multi-' + serial;
    const a = fixture({ namespace }),
      b = fixture({ namespace });
    a.append();
    b.append();
    expect(a.file).toBe(b.file);
    expect(a.read().map((row) => row.dot_id)).toEqual([a.id]);
    expect(b.read().map((row) => row.dot_id)).toEqual([b.id]);
    const marker = a.marker(),
      scope = records.dotResultScopeSchema.parse(b.charter.scope);
    expect(() =>
      store.appendConfidentialDotReportMarker(
        b.charter,
        marker,
        origin.mintDotReportMarkerPermit({ rootDir: root, charter: a.charter, scope, marker }),
        { rootDir: root }
      )
    ).toThrow();
  });
  it('a paused or revised current charter with unchanged ownership does not discard its captured original outcome', () => {
    const f = fixture(),
      token = f.mint();
    io.safeWriteFile(
      f.charterPath,
      JSON.stringify({ ...f.charter, status: 'paused', version: '1.0.1' })
    );
    expect(f.append(f.row, token).result.status).toBe('done');
  });
  it.each([
    'missing-permit',
    'forged',
    'wrong-row',
    'wrong-dot',
    'skipped',
    'unsupported-phase',
  ] as const)('refuses %s without a result', (condition) => {
    const f = fixture();
    let row = { ...f.row },
      token: unknown = f.mint();
    if (condition === 'missing-permit') token = undefined;
    if (condition === 'forged') token = { kind: 'active_execution', ...f.claim };
    if (condition === 'wrong-row') row.summary = 'Changed after issuance';
    if (condition === 'wrong-dot') row.dot_id = 'another-dot';
    if (condition === 'skipped') row.status = 'skipped';
    if (condition === 'unsupported-phase')
      token = origin.mintDotResultOutcomePermit({
        rootDir: root,
        charter: f.charter,
        scope: records.dotResultScopeSchema.parse(f.charter.scope),
        row: f.row,
        phase: 'pipeline_continuation',
        leaseId: f.claim.lease.lease_id,
      });
    expect(() =>
      store.appendConfidentialDotWorkResult(f.charter, row, token, { rootDir: root })
    ).toThrow();
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
  it.each([
    'expired',
    'released',
    'wrong-user',
    'wrong-run',
    'changed-scope',
    'changed-target',
    'missing-history',
  ] as const)('refuses changed actual %s proof', (condition) => {
    const f = fixture(),
      token = f.mint();
    if (condition === 'expired') vi.setSystemTime(time + 60000);
    if (condition === 'released')
      coordination.releaseWorkItem({
        itemId: f.before.item_id,
        leaseId: f.claim.lease.lease_id,
        actorPeerId: 'dot:' + f.id,
        nextStatus: 'ready',
      });
    if (condition === 'wrong-user' || condition === 'wrong-run') {
      const item = structuredClone(f.item());
      if (condition === 'wrong-user') item.claimed_by_user_id = 'user:other';
      else item.current_attempt_id = 'other-run';
      ledger.withCoordinationRoot(root, () =>
        ledger.appendItemSnapshot({ ...item, version: item.version + 1 })
      );
    }
    if (condition === 'changed-scope')
      io.safeWriteFile(
        f.charterPath,
        JSON.stringify({ ...f.charter, scope: { ...f.charter.scope, project_id: 'other-project' } })
      );
    if (condition === 'changed-target')
      coordination.updateWorkItem({
        rootDir: root,
        itemId: f.before.item_id,
        expectedVersion: f.item().version,
        metadata: { ...f.item().metadata, target: 'service:other' },
      });
    if (condition === 'missing-history')
      io.safeWriteFile(ledger.withCoordinationRoot(root, ledger.itemsPath), '');
    expect(() => f.append(f.row, token)).toThrow();
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
  it('revalidates actual claim after lock waiting before the first privileged write', () => {
    const f = fixture();
    const original = locks.withLockSync;
    let expired = false;
    vi.spyOn(locks, 'withLockSync').mockImplementation((name, fn, options) => {
      if (String(name).startsWith('dot-results-') && !expired) {
        expired = true;
        vi.setSystemTime(time + 60000);
      }
      return original(name, fn, options);
    });
    expect(() => f.append()).toThrow('lease');
    expect(expired).toBe(true);
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
  it('an append I/O failure retains actual ownership and cannot replay the consumed permit', () => {
    const f = fixture(),
      token = f.mint();
    vi.spyOn(io, 'safeAppendFileSync').mockImplementation(() => {
      throw new Error('Injected append failure');
    });
    expect(() => f.append(f.row, token)).toThrow('Injected append failure');
    expect(() => f.append(f.row, token)).toThrow();
    expect(f.item()).toMatchObject({
      status: 'in_progress',
      lease_id: f.claim.lease.lease_id,
      effect_ownership: { state: 'held' },
    });
  });
  it('revalidates after parsing the existing shared journal if the actual lease expires while reading', () => {
    const namespace = 'parse-' + serial,
      other = fixture({ namespace }),
      f = fixture({ namespace });
    other.append();
    const read = io.safeReadFile;
    let advanced = false;
    vi.spyOn(io, 'safeReadFile').mockImplementation((file, options) => {
      const result = read(file, options);
      if (String(file) === f.file && !advanced) {
        advanced = true;
        vi.setSystemTime(time + 60000);
      }
      return result;
    });
    expect(() => f.append()).toThrow('lease');
    expect(advanced).toBe(true);
    vi.restoreAllMocks();
    expect(f.read()).toHaveLength(0);
  });
  it('current scope changes during file-lock waiting cannot publish under captured ownership', () => {
    const f = fixture(),
      original = locks.withLockSync;
    let changed = false;
    vi.spyOn(locks, 'withLockSync').mockImplementation((name, fn, options) => {
      if (String(name).startsWith('dot-results-') && !changed) {
        changed = true;
        io.safeWriteFile(
          f.charterPath,
          JSON.stringify({
            ...f.charter,
            scope: { ...f.charter.scope, project_id: 'changed-project' },
          })
        );
      }
      return original(name, fn, options);
    });
    expect(() => f.append()).toThrow();
    expect(changed).toBe(true);
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
  it('report markers require an actual immutable original and cannot replay a consumed report permit', () => {
    const f = fixture();
    f.append();
    const marker = f.marker(),
      scope = records.dotResultScopeSchema.parse(f.charter.scope);
    const token = origin.mintDotReportMarkerPermit({
      rootDir: root,
      charter: f.charter,
      scope,
      marker,
    });
    store.appendConfidentialDotReportMarker(f.charter, marker, token, { rootDir: root });
    expect(() =>
      store.appendConfidentialDotReportMarker(f.charter, marker, token, { rootDir: root })
    ).toThrow();
    const forged = { ...marker, result_digest: 'a'.repeat(64) };
    const forgedToken = origin.mintDotReportMarkerPermit({
      rootDir: root,
      charter: f.charter,
      scope,
      marker: forged,
    });
    expect(() =>
      store.appendConfidentialDotReportMarker(f.charter, forged, forgedToken, { rootDir: root })
    ).toThrow('missing');
    expect(f.read()).toHaveLength(1);
  });
  it('existing source read denial remains a denial instead of borrowing the result-file capability', () => {
    const f = fixture(),
      token = f.mint();
    expect(() =>
      authority.withExecutionContext(
        'infrastructure_sentinel',
        () => f.append(f.row, token),
        undefined,
        'result-tenant',
        'result-org'
      )
    ).toThrow();
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
  it('public legacy result append retains its existing file and JSON row format', async () => {
    const f = fixture({ tier: 'public' }),
      reports = await import('./dot-executor-reports.js');
    reports.appendWorkResult(f.charter, f.row, { rootDir: root });
    expect(String(io.safeReadFile(f.file, { encoding: 'utf8' }))).toBe(
      JSON.stringify(f.row) + '\n'
    );
    expect(reports.readDotWorkResults(f.charter, { rootDir: root })).toEqual([f.row]);
    expect(() => f.read()).toThrow();
  });
  it('normalizes caller getters/prototypes/options before granting access and rejects alternate roots/public scope', () => {
    const f = fixture();
    const getter = Object.defineProperty({ ...f.charter }, 'scope', {
      enumerable: true,
      get: () => {
        throw new Error('getter should not execute');
      },
    });
    expect(() => store.readConfidentialDotResultState(getter)).toThrow('Lossy');
    expect(() =>
      store.readConfidentialDotResultState(Object.assign(Object.create(null), f.charter))
    ).toThrow();
    expect(() =>
      store.readConfidentialDotResultState(f.charter, { rootDir: path.dirname(root) })
    ).toThrow('root');
    expect(() =>
      store.readConfidentialDotResultState({ ...f.charter, scope: { tier: 'public' } })
    ).toThrow();
  });
  it('direct charter role and unbound writer role retain their existing denials', () => {
    const f = fixture();
    io.safeMkdir(path.dirname(f.file), { recursive: true });
    io.safeWriteFile(f.file, '');
    expect(() =>
      authority.withExecutionContext(
        'infrastructure_sentinel',
        () => io.safeAppendFileSync(f.file, 'forged\n'),
        undefined,
        'result-tenant',
        'result-org'
      )
    ).toThrow();
    expect(() =>
      authority.withExecutionContext(
        'dot_result_writer',
        () => io.safeReadFile(f.file),
        undefined,
        'result-tenant',
        'result-org'
      )
    ).toThrow();
  });
  it.each(['leaf-symlink', 'ancestor-symlink', 'hardlink', 'corrupt-other-row'] as const)(
    'refuses %s in the shared private journal',
    (condition) => {
      const f = fixture();
      io.safeMkdir(path.dirname(f.file), { recursive: true });
      const other = path.join(root, 'active/shared/tmp', f.id + '-other');
      if (condition === 'leaf-symlink') {
        io.safeWriteFile(other, '');
        io.safeSymlinkSync(other, f.file, 'file');
      }
      if (condition === 'ancestor-symlink') {
        io.safeRmSync(path.dirname(f.file), { recursive: true });
        io.safeMkdir(other, { recursive: true });
        io.safeSymlinkSync(other, path.dirname(f.file), 'dir');
      }
      if (condition === 'hardlink') {
        io.safeWriteFile(other, '');
        io.safeLinkExclusiveSync(other, f.file);
      }
      if (condition === 'corrupt-other-row')
        io.safeWriteFile(
          f.file,
          JSON.stringify({ ...f.row, dot_id: 'other-dot', status: 'invented' }) + '\n'
        );
      expect(() => f.read()).toThrow();
      expect(() => f.append()).toThrow();
    }
  );
});

describe('exact historical expired-lease quarantine phase', () => {
  it.each([false, true])(
    'records only blocked unknown status from real expiry/release history (park=%s)',
    (park) => {
      const f = negativeFixture(park),
        before = JSON.stringify(f.item());
      expect(f.item().status).toBe(park ? 'blocked' : 'ready');
      const result = f.negativeAppend();
      expect(result).toMatchObject({
        status: 'persisted',
        appended: true,
        result: { status: 'blocked', mode: 'escalated', attempt_id: f.negativeRow.attempt_id },
      });
      expect(JSON.stringify(f.item())).toBe(before);
      expect(f.item().effect_ownership?.state).toBe('held');
      expect(f.negativeAppend().appended).toBe(false);
      expect(f.read()).toHaveLength(1);
    }
  );
  it.each(['done', 'failed', 'pre-effect', 'pipeline', 'usage', 'approval-reference'] as const)(
    'cannot turn unknown recovery into %s evidence',
    (condition) => {
      const f = negativeFixture(),
        row = { ...f.negativeRow };
      if (condition === 'done') row.status = 'done';
      if (condition === 'failed') row.status = 'failed';
      if (condition === 'pre-effect') row.reason_code = 'pre_effect_failure';
      if (condition === 'pipeline') row.mode = 'pipeline';
      if (condition === 'usage') row.tokens_used = 1;
      if (condition === 'approval-reference') row.approval_request_id = 'unverified';
      expect(() => f.negativeAppend(row)).toThrow();
      expect(io.safeExistsSync(f.file)).toBe(false);
    }
  );
  it('rejects replayed negative permits and active-execution permits after real expiry', () => {
    const active = fixture(),
      activePermit = active.mint();
    vi.setSystemTime(time + 60000);
    coordination.reapExpiredWorkLeases();
    const row: DotWorkResultRow = { ...active.row, mode: 'escalated', status: 'blocked' };
    delete row.tokens_used;
    delete row.kr_snapshot;
    delete row.signal_snapshot;
    row.started_at = row.completed_at = new Date().toISOString();
    expect(() =>
      store.appendConfidentialDotWorkResult(active.charter, row, activePermit, { rootDir: root })
    ).toThrow();
    const f = negativeFixture(),
      token = f.negativeMint();
    f.negativeAppend(f.negativeRow, token);
    expect(() => f.negativeAppend(f.negativeRow, token)).toThrow();
  });
  it.each([
    'missing-claim',
    'missing-start',
    'missing-expiry',
    'missing-release',
    'wrong-event-user',
    'lease-lost',
    'wrong-user',
    'active-lease',
    'new-attempt',
    'settled-completed',
    'operator-release',
    'scope-drift',
    'missing-history',
  ] as const)('refuses missing or changed retained %s proof', (condition) => {
    const f = negativeFixture(),
      token = f.negativeMint();
    const eventFile = ledger.withCoordinationRoot(root, ledger.eventsPath);
    if (condition.startsWith('missing-') && condition !== 'missing-history') {
      const kind = {
        'missing-claim': 'item_claimed',
        'missing-start': 'item_attempt_started',
        'missing-expiry': 'lease_expired',
        'missing-release': 'item_attempt_released',
      }[condition];
      const rows = json
        .readJsonLines<{ event_type: string }>(eventFile)
        .filter((event) => event.event_type !== kind);
      io.safeWriteFile(eventFile, rows.map((row) => JSON.stringify(row) + '\n').join(''));
    } else if (condition === 'wrong-event-user') {
      const rows = json.readJsonLines<{ event_type: string; payload?: Record<string, unknown> }>(
        eventFile
      );
      for (const event of rows)
        if (event.event_type === 'lease_expired')
          event.payload = { ...event.payload, holder_user_id: 'user:other' };
      io.safeWriteFile(eventFile, rows.map((row) => JSON.stringify(row) + '\n').join(''));
    } else if (condition === 'wrong-user' || condition === 'active-lease') {
      ledger.withCoordinationRoot(root, () => {
        const lease = ledger
          .currentLeaseRecords()
          .find((lease) => lease.lease_id === f.claim.lease.lease_id)!;
        // Deliberate invalid retained-state corruption, never a manufactured positive lease proof.
        ledger.appendLeaseSnapshot({
          ...lease,
          ...(condition === 'wrong-user'
            ? { holder_user_id: 'user:other' }
            : { status: 'active', expires_at: new Date(time + 120000).toISOString() }),
        });
      });
    } else if (condition === 'scope-drift')
      io.safeWriteFile(
        f.charterPath,
        JSON.stringify({
          ...f.charter,
          scope: { ...f.charter.scope, project_id: 'foreign-project' },
        })
      );
    else if (condition === 'missing-history')
      io.safeWriteFile(ledger.withCoordinationRoot(root, ledger.itemsPath), '');
    else {
      const item = structuredClone(f.item());
      if (condition === 'lease-lost') item.attempts!.at(-1)!.failure_reason = 'lease_lost';
      if (condition === 'new-attempt')
        item.attempts!.push({
          ...item.attempts!.at(-1)!,
          attempt_id: 'new-attempt',
          run_id: 'new-run',
        });
      if (condition === 'settled-completed')
        item.effect_ownership = {
          ...item.effect_ownership!,
          state: 'settled',
          settlement: 'completed',
          settled_at: new Date().toISOString(),
        };
      if (condition === 'operator-release')
        item.metadata = {
          ...item.metadata,
          dot_executor: {
            operator_verified_at: new Date().toISOString(),
            operator_verified_approval_id: 'must-not-reuse',
          },
        };
      ledger.withCoordinationRoot(root, () =>
        ledger.appendItemSnapshot({ ...item, version: item.version + 1 })
      );
    }
    expect(() => f.negativeAppend(f.negativeRow, token)).toThrow();
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
  it('rechecks the historical fingerprint after waiting for the result lock before publication', () => {
    const f = negativeFixture(),
      original = locks.withLockSync;
    let changed = false;
    vi.spyOn(locks, 'withLockSync').mockImplementation((name, fn, options) => {
      if (String(name).startsWith('dot-results-') && !changed) {
        changed = true;
        const item = f.item();
        ledger.withCoordinationRoot(root, () =>
          ledger.appendItemSnapshot({
            ...item,
            version: item.version + 1,
            metadata: {
              ...item.metadata,
              dot_executor: { operator_verified_at: new Date().toISOString() },
            },
          })
        );
      }
      return original(name, fn, options);
    });
    expect(() => f.negativeAppend()).toThrow();
    expect(changed).toBe(true);
    expect(io.safeExistsSync(f.file)).toBe(false);
  });
});
