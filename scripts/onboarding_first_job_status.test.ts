import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
  FIRST_JOB_TEST_SESSION_KEY,
  FIRST_JOB_TEST_ISSUER,
  FIRST_JOB_TEST_SUBJECT,
} from './fixtures/first-job-approval-fixture.js';

const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp', 'first-job-request-status-' + process.pid);
const tenant = 'status-fixture';
const requestId = '11111111-1111-4111-8111-111111111111';
const absentId = '22222222-2222-4222-8222-222222222222';
let api: typeof import('./onboarding_first_job.js');
let status: typeof import('./onboarding_first_job_status.js');
let store: typeof import('@agent/core/surface/front-desk-conversation-store');
let work: typeof import('@agent/core/workforce/work-coordination');
let dispatch: typeof import('@agent/core/dot/dot-dispatch');
let execution: typeof import('@agent/core/surface/front-desk-execution');
let executor: typeof import('./dot_executor_step.js');
let approval: typeof import('@agent/core/surface/first-job-approval');
let approvalStore: typeof import('@agent/core/governance/approval-store');
let browser: typeof import('@agent/core/authn-providers');
let authority: typeof import('@agent/core/authority');
let foundation: typeof import('@agent/core/foundation');
let charters: typeof import('@agent/core/dot/dot-charter');
let results: typeof import('@agent/core/dot/dot-executor-reports');
let control: typeof import('@agent/core/cloudflare-os-shared');

function put(file: string, value: unknown): void {
  authority.withExecutionContext('ecosystem_architect', () => {
    const target = path.join(root, file);
    safeMkdir(path.dirname(target), { recursive: true });
    safeWriteFile(
      target,
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'
    );
  });
}
function snapshot() {
  return authority.withExecutionContext('ecosystem_architect', () => {
    const rows: Array<[string, string]> = [];
    const visit = (file: string) => {
      if (!safeExistsSync(file)) return;
      const stat = safeLstat(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (stat.isDirectory()) {
        rows.push([relative, 'directory']);
        for (const name of safeReaddir(file).sort()) visit(path.join(file, name));
      } else
        rows.push([
          relative,
          createHash('sha256')
            .update(safeReadFile(file, { encoding: null }))
            .digest('hex'),
        ]);
    };
    visit(root);
    return rows;
  });
}
async function read(id = requestId) {
  const prohibited = [
    vi.spyOn(dispatch, 'runDotHousekeeping'),
    vi.spyOn(execution, 'runFrontDeskExecutionIntake'),
    vi.spyOn(executor, 'runDotExecutorStep'),
    vi.spyOn(work, 'reapExpiredWorkLeases'),
    vi.spyOn(work, 'expireWorkItemLeases'),
    vi.spyOn(store, 'readConversationExecutionReports'),
    vi.spyOn(approvalStore, 'decideApprovalRequest'),
    vi.spyOn(control, 'sharedControlPlane'),
  ];
  for (const spy of prohibited) spy.mockClear();
  const before = snapshot();
  const identity = authority.resolveIdentityContext();
  const value = await status.readFirstJobStatus(tenant, id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(snapshot()).toEqual(before);
  expect(authority.resolveIdentityContext()).toEqual(identity);
  for (const spy of prohibited) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
  expect(JSON.stringify(value)).not.toMatch(
    /PRIVATE_|artifact_path|knowledge\/|active\/|approval_request_id|member_id|session_id|display_digest|payload_hash/
  );
  expect(value).toMatchObject({ read_only: true, authorizes_execution: false });
  return value;
}
function configure(organization = false) {
  const plan = api.planFirstJob(tenant);
  const configured = api.applyFirstJob(tenant, plan.plan_digest);
  if (organization) {
    configured.mapping.viewer.organizationIds = ['fixture-org'];
    configured.mapping.viewer.projectIds = ['fixture-project'];
    const charter = charters.findDotCharter(configured.dot_id)!.charter;
    charter.scope.organization_id = 'fixture-org';
    charter.scope.project_id = 'fixture-project';
    put('dots/' + configured.dot_id + '.json', charter);
    put('knowledge/product/governance/front-desk-execution-policy.json', {
      version: 1,
      mappings: [configured.mapping],
    });
  }
  put('knowledge/personal/members/owner.json', syntheticFirstJobOwner(tenant));
  const token = browser.mintBrowserSessionToken({
    idpIssuer: FIRST_JOB_TEST_ISSUER,
    subject: FIRST_JOB_TEST_SUBJECT,
    ttlSeconds: 1800,
  }).token;
  store.reserveConversationTurn(
    configured.mapping.viewer,
    configured.mapping.exactCommand,
    requestId
  );
  return { configured, viewer: configured.mapping.viewer, token };
}
async function pending() {
  const fixture = configure();
  await api.tickFirstJob(tenant);
  const session_id = store.conversationRef(fixture.viewer).sessionId;
  const card = approval.readFirstJobApprovals(fixture.viewer, fixture.token, { session_id })
    .approvals[0];
  expect(card).toBeTruthy();
  return { ...fixture, session_id, card };
}
function decide(
  fixture: Awaited<ReturnType<typeof pending>>,
  decision: 'approved' | 'rejected' = 'approved'
) {
  approval.decideFirstJobApproval(fixture.viewer, fixture.token, fixture.card.approval_request_id, {
    decision,
    display_digest: fixture.card.display_digest,
    session_id: fixture.session_id,
  });
}
beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const key of [
    'MISSION_ID',
    'SYSTEM_ROLE',
    'KYBERION_TENANT',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_PROJECT_ID',
    'KYBERION_SUDO',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  vi.stubEnv('KYBERION_SESSION_SECRET', FIRST_JOB_TEST_SESSION_KEY);
  vi.stubEnv('KYBERION_OIDC_ISSUER', FIRST_JOB_TEST_ISSUER);
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
  vi.useFakeTimers({ now: new Date('2026-10-06T00:00:00Z'), toFake: ['Date'] });
  vi.resetModules();
  authority = await import('@agent/core/authority');
  foundation = await import('@agent/core/foundation');
  api = await import('./onboarding_first_job.js');
  status = await import('./onboarding_first_job_status.js');
  store = await import('@agent/core/surface/front-desk-conversation-store');
  work = await import('@agent/core/workforce/work-coordination');
  dispatch = await import('@agent/core/dot/dot-dispatch');
  execution = await import('@agent/core/surface/front-desk-execution');
  executor = await import('./dot_executor_step.js');
  approval = await import('@agent/core/surface/first-job-approval');
  approvalStore = await import('@agent/core/governance/approval-store');
  browser = await import('@agent/core/authn-providers');
  charters = await import('@agent/core/dot/dot-charter');
  results = await import('@agent/core/dot/dot-executor-reports');
  control = await import('@agent/core/cloudflare-os-shared');
}, 60_000);
beforeEach(() => {
  for (const key of ['SYSTEM_ROLE', 'MISSION_ID', 'KYBERION_SUDO', 'KYBERION_TENANT'])
    vi.stubEnv(key, '');
  authority.withExecutionContext('ecosystem_architect', () => {
    for (const directory of ['active', 'dots', 'knowledge/personal', 'knowledge/confidential'])
      safeRmSync(path.join(root, directory), { recursive: true, force: true });
  });
  put('knowledge/product/governance/front-desk-execution-policy.json', {
    version: 1,
    mappings: [],
  });
  work.clearWorkCoordinationNamespace();
  vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  process.chdir(sourceRoot);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  safeRmSync(root, { recursive: true, force: true });
});
describe('request-bound first-job status with real governed stores', { timeout: 60_000 }, () => {
  it('keeps the actual onboarding harness status path read-only and its failures identical', async () => {
    configure();
    const { runOnboarding } = await import('./onboarding.js');
    const harness = await import('./lib/harness.js');
    const stdout: unknown[][] = [],
      stderr: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args);
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args);
    });
    const before = snapshot();
    await runOnboarding([
      'first-job',
      '--tenant',
      tenant,
      '--status',
      '--request-id',
      requestId,
      '--json',
    ]);
    expect(JSON.parse(String(stdout[0][0]))).toMatchObject({ status: 'intake_not_observed' });
    expect(stderr).toEqual([]);
    expect(snapshot()).toEqual(before);
    stdout.length = 0;
    const cases = [
      ['first-job', '--tenant', tenant, '--status', '--request-id', absentId, '--json'],
      ['first-job', '--tenant', tenant, '--status', '--request-id', '../PRIVATE', '--json'],
      ['first-job', '--tenant', 'other-tenant', '--status', '--request-id', requestId, '--json'],
      ['first-job', '--tenant', tenant, '--status', '--request-id', requestId, '--tick', '--json'],
    ];
    for (const args of cases) {
      harness.clearProcessExitCode();
      await runOnboarding(args);
      expect(harness.getProcessExitCode()).toBe(1);
      harness.clearProcessExitCode();
    }
    expect(stdout).toHaveLength(cases.length);
    expect(new Set(stdout.map((row) => String(row[0]))).size).toBe(1);
    expect(stderr).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
  it('rejects missing or forged attempts and contradictory same-item results before success', async () => {
    const fixture = await pending();
    decide(fixture);
    await api.tickFirstJob(tenant);
    const item = work.listWorkItems()[0];
    const itemFile = 'active/shared/runtime/work-coordination/items.jsonl';
    const savedItems = String(safeReadFile(path.join(root, itemFile)));
    for (const patch of [
      { attempts: [], current_attempt_id: undefined },
      { current_attempt_id: 'forged-attempt' },
      { attempts: [{ ...item.attempts![0], run_id: 'forged-attempt' }] },
      { context: { ...item.context, project_id: 'foreign-project' } },
      { version: -1 },
    ]) {
      put(itemFile, savedItems + JSON.stringify({ ...item, ...patch }) + '\n');
      expect((await read()).status).toBe('uncertain');
    }
    put(itemFile, savedItems);
    const charter = charters.findDotCharter(fixture.configured.dot_id)!.charter;
    const { dotStatePath, DOT_WORK_RESULTS_FILE } = await import('@agent/core/dot/dot-state-paths');
    const resultFile = dotStatePath(charter, DOT_WORK_RESULTS_FILE);
    const savedResults = String(safeReadFile(path.join(root, resultFile)));
    const row = results.readDotWorkResults(charter).at(-1)!;
    put(resultFile, savedResults + JSON.stringify({ ...row, dot_id: 'foreign-dot' }) + '\n');
    expect((await read()).status).toBe('uncertain');
    put(resultFile, savedResults);
    const projected = store.readFrontDeskConversationRequestWork;
    vi.spyOn(store, 'readFrontDeskConversationRequestWork').mockImplementationOnce((...args) => {
      const value = projected(...args);
      value!.turnState = 'uncertain';
      return value;
    });
    expect((await read()).status).toBe('uncertain');
  });
  it('reports queued/running only with exact current attempt and live lease ownership', async () => {
    const fixture = await pending();
    decide(fixture);
    vi.spyOn(executor, 'runDotExecutorStep').mockResolvedValueOnce([]);
    await api.tickFirstJob(tenant);
    expect((await read()).status).toBe('queued');
    const item = work.listWorkItems()[0];
    work.claimWorkItem({
      itemId: item.item_id,
      expectedVersion: item.version,
      actorPeerId: 'status-fixture-worker',
      purpose: 'status fixture',
      ttlMs: 60_000,
    });
    expect((await read()).status).toBe('running');
    const leasesFile = 'active/shared/runtime/work-coordination/leases.jsonl';
    const saved = String(safeReadFile(path.join(root, leasesFile)));
    const lease = work.listActiveWorkLeases()[0];
    put(leasesFile, saved + JSON.stringify({ ...lease, holder_peer_id: 'foreign-worker' }) + '\n');
    expect((await read()).status).toBe('uncertain');
    put(leasesFile, saved + JSON.stringify({ ...lease, lease_id: 'duplicate-live-lease' }) + '\n');
    expect((await read()).status).toBe('uncertain');
    put(leasesFile, saved);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect((await read()).status).toBe('uncertain');
  });
  it('refuses opt-in role tracing before assumptions or trace-file creation', async () => {
    configure();
    const before = snapshot();
    vi.stubEnv(
      'KYBERION_ROLE_ASSUMPTION_TRACE',
      'active/shared/tmp/role-assumption-trace/private.jsonl'
    );
    try {
      expect(await status.readFirstJobStatus(tenant, requestId)).toEqual(
        status.firstJobStatusUnavailable()
      );
    } finally {
      vi.stubEnv('KYBERION_ROLE_ASSUMPTION_TRACE', '');
    }
    expect(snapshot()).toEqual(before);
  });
  it('does not enumerate tenant charters or project a neighboring request', async () => {
    const fixture = configure();
    store.reserveConversationTurn(
      fixture.viewer,
      fixture.configured.mapping.exactCommand,
      absentId
    );
    const registry = await import('@agent/core/organization/tenant-registry');
    const enumerate = vi.spyOn(registry, 'listTenantProfileSlugs');
    const resolve = vi.spyOn(registry, 'resolveTenant');
    expect((await read()).status).toBe('intake_not_observed');
    expect(enumerate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    const selected = store.readFrontDeskConversationRequestWork(fixture.viewer, requestId);
    expect(selected?.id).toBe(requestId);
  });
  it('rejects a duplicated selected task before projecting either body', async () => {
    const fixture = configure();
    const ref = store.conversationRef(fixture.viewer);
    const transcript = JSON.parse(String(safeReadFile(path.join(root, ref.path))));
    transcript.taskState.tasks.push({
      ...transcript.taskState.tasks[0],
      title: 'PRIVATE_DUPLICATE',
      requestText: 'PRIVATE_OTHER_BODY',
    });
    put(ref.path, transcript);
    expect(await read()).toEqual(status.firstJobStatusUnavailable());
    expect(() => store.readFrontDeskConversationRequestWork(fixture.viewer, requestId)).toThrow();
  });
  it('preserves mandatory security auditing on an inactive tenant read denial', async () => {
    const fixture = await pending();
    decide(fixture);
    const profilePath = 'knowledge/personal/tenants/' + tenant + '.json';
    const profile = JSON.parse(String(safeReadFile(path.join(root, profilePath))));
    put(profilePath, { ...profile, status: 'suspended' });
    const { auditChain } = await import('@agent/core/governance/audit-chain');
    // Observe the mandatory port without recursively exercising audit persistence
    // under an inactive tenant. The real sink is intentionally unchanged.
    const audit = vi.spyOn(auditChain, 'record').mockImplementation((entry) => ({
      ...entry,
      id: 'synthetic-audit-port',
      timestamp: new Date().toISOString(),
      previousHash: 'synthetic',
      currentHash: 'synthetic',
    }));
    vi.stubEnv('KYBERION_TENANT', tenant);
    vi.stubEnv('KYBERION_TENANT_SCOPE_REQUIRED', '1');
    try {
      expect(await status.readFirstJobStatus(tenant, requestId)).toEqual(
        status.firstJobStatusUnavailable()
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tenant.scope_violation' })
      );
    } finally {
      vi.stubEnv('KYBERION_TENANT', '');
      vi.stubEnv('KYBERION_TENANT_SCOPE_REQUIRED', '');
    }
  });
  it('rejects a suspended mapped tenant even without mandatory tenant-scope auditing', async () => {
    configure();
    const profilePath = 'knowledge/personal/tenants/' + tenant + '.json';
    const profile = JSON.parse(String(safeReadFile(path.join(root, profilePath))));
    put(profilePath, { ...profile, status: 'suspended' });
    expect(await read()).toEqual(status.firstJobStatusUnavailable());
  });
  it('observes pre-intake without creating ledgers, cards, directories or effects', async () => {
    configure();
    expect(await read()).toMatchObject({
      status: 'intake_not_observed',
      next_actor: 'operator',
      next_action: 'inspect_tick',
    });
  });
  it('supports an exact organization/project mapping without the setup planner', async () => {
    configure(true);
    expect(await read()).toMatchObject({ status: 'intake_not_observed' });
  });
  it('separates current pending approval from signed approval and verified receipt bytes', async () => {
    const fixture = await pending();
    expect(await read()).toMatchObject({ status: 'awaiting_approval', next_actor: 'user' });
    decide(fixture);
    expect(await read()).toMatchObject({
      status: 'approved_awaiting_tick',
      next_actor: 'operator',
    });
    await api.tickFirstJob(tenant);
    expect(await read()).toMatchObject({
      status: 'artifact_verified',
      next_action: 'view_artifact',
    });
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    expect((await read()).status).toBe('artifact_verified');
    const charter = charters.findDotCharter(fixture.configured.dot_id)!.charter;
    const row = results.readDotWorkResults(charter).at(-1)!;
    put(row.front_desk_verification!.artifact_path, 'PRIVATE_TAMPERED');
    expect((await read()).status).toBe('uncertain');
  });
  it('does not substitute a newer pending request for the selected verified request', async () => {
    const fixture = await pending();
    decide(fixture);
    await api.tickFirstJob(tenant);
    store.reserveConversationTurn(
      fixture.viewer,
      fixture.configured.mapping.exactCommand,
      absentId
    );
    await api.tickFirstJob(tenant);
    expect((await read()).status).toBe('artifact_verified');
    expect((await read(absentId)).status).toBe('awaiting_approval');
  });
  it('reports refusal without a settlement tick', async () => {
    const fixture = await pending();
    decide(fixture, 'rejected');
    expect((await read()).status).toBe('refused');
    expect(work.listWorkItems()).toHaveLength(0);
  });
  it('observes expiry without expiring or rewriting the pending card', async () => {
    await pending();
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    expect((await read()).status).toBe('expired');
  });
  it('does not mistake an unsigned approved status for a current verified human decision', async () => {
    const fixture = await pending();
    const record = approvalStore.loadApprovalRequest('autonomy', fixture.card.approval_request_id)!;
    put(approvalStore.approvalRequestLogicalPath('autonomy', record.id), {
      ...record,
      status: 'approved',
    });
    expect((await read()).status).toBe('uncertain');
  });
  it('revokes the approved handoff when the current identity or proof changes', async () => {
    const fixture = await pending();
    decide(fixture);
    const record = approvalStore.loadApprovalRequest('autonomy', fixture.card.approval_request_id)!;
    const file = approvalStore.approvalRequestLogicalPath('autonomy', record.id);
    for (const patch of [
      { diagnosticDecision: { ...record.diagnosticDecision, signature: '0'.repeat(64) } },
      { scope: { ...record.scope, tenant_slug: 'other-tenant' } },
      { accountability: { ...record.accountability, payloadHash: '0'.repeat(64) } },
      { diagnosticDecision: undefined },
    ]) {
      put(file, { ...record, ...patch });
      expect((await read()).status).toBe('uncertain');
    }
    put(file, record);
    put('knowledge/personal/members/owner.json', {
      ...syntheticFirstJobOwner(tenant),
      status: 'suspended',
    });
    expect((await read()).status).not.toBe('approved_awaiting_tick');
  });
  it('rejects corrupted retained action/result history instead of inferring no work', async () => {
    const fixture = await pending();
    put(dispatch.DOT_ACTION_LEDGER_PATH, 'PRIVATE_CORRUPT\n');
    expect((await read()).status).toBe('uncertain');
    const charter = charters.findDotCharter(fixture.configured.dot_id)!.charter;
    put(dispatch.DOT_ACTION_LEDGER_PATH, '');
    const { dotStatePath, DOT_WORK_RESULTS_FILE } = await import('@agent/core/dot/dot-state-paths');
    put(dotStatePath(charter, DOT_WORK_RESULTS_FILE), '{invalid\n');
    expect((await read()).status).toBe('uncertain');
  });
  it('returns exactly the same unavailable projection for malformed, missing, scoped and denied reads', async () => {
    configure();
    const expected = status.firstJobStatusUnavailable();
    expect(await read(absentId)).toEqual(expected);
    expect(await read('../PRIVATE')).toEqual(expected);
    vi.stubEnv('KYBERION_TENANT', 'other-tenant');
    expect(await read()).toEqual(expected);
    vi.stubEnv('KYBERION_TENANT', '');
    vi.spyOn(store, 'listConfiguredFrontDeskExecutions').mockImplementationOnce(() => {
      throw Error('PRIVATE_PERMISSION /private/path');
    });
    expect(await read()).toEqual(expected);
    put('knowledge/product/governance/front-desk-execution-policy.json', {
      version: 1,
      mappings: [],
    });
    expect(await read()).toEqual(expected);
  });
  it.each(['SYSTEM_ROLE', 'MISSION_ID', 'KYBERION_SUDO'] as const)(
    'rejects ambient %s before scoped evidence reads',
    async (key) => {
      configure();
      const before = snapshot();
      vi.stubEnv(key, key === 'KYBERION_SUDO' ? '1' : 'foreign');
      try {
        expect(await status.readFirstJobStatus(tenant, requestId)).toEqual(
          status.firstJobStatusUnavailable()
        );
      } finally {
        vi.stubEnv(key, '');
      }
      expect(snapshot()).toEqual(before);
    }
  );
});
describe('first-job status CLI grammar and redacted failure envelope', () => {
  const valid = ['--tenant', tenant, '--status', '--request-id', requestId];
  it('accepts only an explicit exact request selection', () => {
    expect(status.parseFirstJobStatusArgs(valid)).toEqual({ tenant, requestId });
    expect(status.parseFirstJobStatusArgs([...valid, '--json'])).toEqual({ tenant, requestId });
  });
  it.each([
    ['--status'],
    ['--request-id', requestId],
    [...valid, '--tick'],
    [...valid, '--apply'],
    [...valid, '--dry-run'],
    [...valid, '--accept-plan', 'digest'],
    [...valid, '--request-id', absentId],
    [...valid, '--tenant', tenant],
    [...valid, '--status'],
    [...valid, '--unknown'],
    ['--status', '--tenant', '--request-id', requestId],
    ['--status', '--tenant', tenant, '--request-id', '../PRIVATE'],
  ])('rejects malformed selectors and mixed modes: %j', async (...input) => {
    const args = input as string[];
    expect(status.parseFirstJobStatusArgs(args)).toBeUndefined();
    const output: unknown[] = [];
    await expect(api.main(args, (value) => output.push(value))).rejects.toMatchObject({
      code: 1,
      silent: true,
    });
    expect(output).toEqual([JSON.stringify(status.firstJobStatusUnavailable(), null, 2)]);
  });
});
