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

// No facade, authority, lock, registry, or IO mocks. Only the root and standalone
// operator environment are isolated. Tick tests seed only synthetic browser identity.
const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp', 'first-job-operator-setup-' + process.pid);
const tenant = 'setup-fixture';
const dotId = 'first-job-' + tenant;
const policyPath = 'knowledge/product/governance/front-desk-execution-policy.json';
const profilePath = 'knowledge/personal/tenants/' + tenant + '.json';
const charterPath = 'dots/' + dotId + '.json';
const protectedSourceFiles = [policyPath, 'knowledge/product/governance/security-policy.json'];
const sourceHashes = new Map<string, string>();
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function put(relative: string, value: unknown): void {
  const target = path.join(root, relative);
  safeMkdir(path.dirname(target), { recursive: true });
  safeWriteFile(target, JSON.stringify(value, null, 2) + '\n');
}
function treeSnapshot(directory = root): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const visit = (absolute: string): void => {
    if (!safeExistsSync(absolute)) return;
    const relative = path.relative(directory, absolute).split(path.sep).join('/');
    const stat = safeLstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('Unexpected fixture symlink: ' + relative);
    if (stat.isDirectory()) {
      found.push([relative, 'directory']);
      for (const name of safeReaddir(absolute).sort()) visit(path.join(absolute, name));
    } else found.push([relative, hash(safeReadFile(absolute, { encoding: null }))]);
  };
  visit(directory);
  return found;
}
let store: typeof import('@agent/core/surface/front-desk-conversation-store');
let work: typeof import('@agent/core/workforce/work-coordination');
let dispatch: typeof import('@agent/core/dot/dot-dispatch');
let executor: typeof import('./dot_executor_step.js');
let execution: typeof import('@agent/core/surface/front-desk-execution');
let browser: typeof import('@agent/core/authn-providers');
let approvals: typeof import('@agent/core/surface/first-job-approval');
let api: typeof import('./onboarding_first_job.js');
let authority: typeof import('@agent/core/authority');
let foundation: typeof import('@agent/core/foundation');
let registry: typeof import('@agent/core/organization/tenant-registry');
let tenantFacade: typeof import('@agent/core/organization/tenant-governance');
let charterFacade: typeof import('@agent/core/dot/dot-charter');
let lifecycle: typeof import('@agent/core/dot/dot-lifecycle');
let io: typeof import('@agent/core/secure-io');
const operator = <T>(fn: () => T): T => authority.withExecutionContext('ecosystem_architect', fn);
const ownedTenant = () =>
  authority.withExecutionContext('sovereign_concierge', () =>
    tenantFacade.mutateTenant({
      verb: 'create',
      slug: tenant,
      displayName: 'Synthetic setup fixture',
      apply: true,
      metadata: { onboarding_first_job: 'public-local-diagnostic-v1', synthetic_public_only: true },
      actor: 'integration-fixture',
    })
  );
function readAudit(): Array<Record<string, unknown>> {
  return foundation
    .readTextFile(path.join(root, lifecycle.DOT_LIFECYCLE_AUDIT_PATH))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => foundation.parseSafeJsonObjectInput(line, 'test lifecycle audit'));
}
function expectNoIdentityOrExecution(): void {
  for (const relative of [
    'knowledge/personal/members',
    'active/organizations',
    'active/shared/coordination/channels',
    'active/shared/runtime/work-coordination',
    'active/shared/runtime/approvals',
    'active/shared/runtime/front-desk-execution',
  ])
    expect(safeExistsSync(path.join(root, relative)), relative).toBe(false);
  const files = treeSnapshot()
    .filter(([, kind]) => kind !== 'directory')
    .map(([name]) => name);
  expect(
    files.filter(
      (name) =>
        !name.startsWith('knowledge/product/') &&
        !name.startsWith('scripts/') &&
        /(?:^|\/)(?:approvals?|credentials?|grants?|members|sessions)(?:\/|\.)/.test(name)
    )
  ).toEqual([]);
  expect(safeReaddir(path.join(root, 'knowledge/personal')).sort()).toEqual(['tenants']);
}

beforeAll(async () => {
  for (const file of protectedSourceFiles)
    sourceHashes.set(file, hash(safeReadFile(path.join(sourceRoot, file), { encoding: null })));
  seedFirstJobTestRoot(sourceRoot, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const key of [
    'MISSION_ID',
    'SYSTEM_ROLE',
    'KYBERION_TENANT',
    'KYBERION_ORGANIZATION',
    'KYBERION_PROJECT_ID',
    'KYBERION_SUDO',
    'KYBERION_SESSION_SECRET',
    'KYBERION_OIDC_ISSUER',
    'KYBERION_OIDC_CLIENT_ID',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  vi.useFakeTimers({ now: new Date('2026-10-06T00:00:00Z'), toFake: ['Date'] });
  vi.resetModules();
  authority = await import('@agent/core/authority');
  foundation = await import('@agent/core/foundation');
  registry = await import('@agent/core/organization/tenant-registry');
  tenantFacade = await import('@agent/core/organization/tenant-governance');
  charterFacade = await import('@agent/core/dot/dot-charter');
  lifecycle = await import('@agent/core/dot/dot-lifecycle');
  io = await import('@agent/core/secure-io');
  api = await import('./onboarding_first_job.js');
  store = await import('@agent/core/surface/front-desk-conversation-store');
  work = await import('@agent/core/workforce/work-coordination');
  dispatch = await import('@agent/core/dot/dot-dispatch');
  executor = await import('./dot_executor_step.js');
  execution = await import('@agent/core/surface/front-desk-execution');
  browser = await import('@agent/core/authn-providers');
  approvals = await import('@agent/core/surface/first-job-approval');
}, 60_000);
beforeEach(() => {
  for (const relative of ['knowledge/personal', 'knowledge/confidential', 'dots', 'active'])
    safeRmSync(path.join(root, relative), { recursive: true, force: true });
  put(policyPath, { version: 1, mappings: [] });
  work.setWorkCoordinationNamespace('first-job-tick-' + randomUUID());
  vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
  for (const key of ['KYBERION_SESSION_SECRET', 'KYBERION_OIDC_ISSUER', 'KYBERION_OIDC_CLIENT_ID'])
    vi.stubEnv(key, '');
});
afterEach(() => {
  vi.restoreAllMocks();
  work.clearWorkCoordinationStore();
  work.clearWorkCoordinationNamespace();
});
afterAll(() => {
  process.chdir(sourceRoot);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  safeRmSync(root, { recursive: true, force: true });
  for (const file of protectedSourceFiles)
    expect(
      hash(safeReadFile(path.join(sourceRoot, file), { encoding: null })),
      'real source remained unchanged: ' + file
    ).toBe(sourceHashes.get(file));
});

describe('standalone first-job setup with real governed facades', { timeout: 60_000 }, () => {
  it('plans without any filesystem mutation or identity creation', () => {
    const before = treeSnapshot();
    const identity = authority.resolveIdentityContext();
    const plan = api.planFirstJob(tenant);
    expect(plan.status).toBe('awaiting_explicit_apply');
    expect(plan.draft.scope).toEqual({ tier: 'public', tenant_slug: tenant });
    expect(plan.mapping.viewer).toMatchObject({
      tenantSlugs: [tenant],
      tierAccess: ['public'],
      organizationIds: 'all',
      projectIds: 'all',
      principalId: 'human:presence-studio-localadmin',
    });
    expect(treeSnapshot()).toEqual(before);
    expect(authority.resolveIdentityContext()).toEqual(identity);
  });
  it('refuses a different accepted digest without changing governed files', () => {
    const plan = api.planFirstJob(tenant);
    const before = treeSnapshot();
    expect(() => api.applyFirstJob(tenant, plan.plan_digest.slice(0, -1))).toThrow(
      'first_job_plan_changed'
    );
    // Lock acquisition may leave empty runtime directories, never a lock or data file.
    expect(treeSnapshot().filter(([, kind]) => kind !== 'directory')).toEqual(
      before.filter(([, kind]) => kind !== 'directory')
    );
    expect(safeReaddir(path.join(root, 'active/shared/runtime/locks'))).toEqual([]);
  });
  it('creates the tenant, records draft then activation, maps last, and repeats without writes', () => {
    const plan = api.planFirstJob(tenant);
    const identity = authority.resolveIdentityContext();
    const beforeApply = new Map(treeSnapshot().filter(([, kind]) => kind !== 'directory'));
    const result = api.applyFirstJob(tenant, plan.plan_digest);
    expect(result.status).toBe('already_configured');
    const changedFiles = treeSnapshot()
      .filter(([name, bytes]) => bytes !== 'directory' && beforeApply.get(name) !== bytes)
      .map(([name]) => name);
    expect(changedFiles.sort()).toEqual(
      [
        profilePath,
        charterPath,
        policyPath,
        lifecycle.DOT_LIFECYCLE_AUDIT_PATH,
        'active/shared/runtime/heartbeats/' + plan.draft.runtime.heartbeat_id + '.json',
      ].sort()
    );
    const profile = operator(() => registry.readTenantProfile(tenant));
    expect(profile).toMatchObject({
      tenant_slug: tenant,
      status: 'active',
      metadata: { onboarding_first_job: 'public-local-diagnostic-v1', synthetic_public_only: true },
    });
    expect(charterFacade.findDotCharter(dotId)?.charter).toEqual({
      ...plan.draft,
      status: 'active',
    });
    expect(foundation.readJson(path.join(root, policyPath))).toEqual({
      version: 1,
      mappings: [plan.mapping],
    });
    expect(readAudit().map((row) => [row.event, row.from, row.to])).toEqual([
      ['dot_draft_created', undefined, 'draft'],
      ['dot_status_transition', 'draft', 'active'],
    ]);
    expectNoIdentityOrExecution();
    expect(authority.resolveIdentityContext()).toEqual(identity);
    expect(() => io.safeReadFile(path.join(root, profilePath))).toThrow();
    const beforeRepeat = treeSnapshot();
    const repeatPlan = api.planFirstJob(tenant);
    expect(api.applyFirstJob(tenant, repeatPlan.plan_digest)).toEqual(result);
    expect(treeSnapshot()).toEqual(beforeRepeat);
  });
  it('resumes an owned draft through activation without recreating it', () => {
    ownedTenant();
    const draft = api.diagnosticDraft(tenant);
    lifecycle.createDraftDotCharter(draft, { actor: 'integration-fixture' });
    const plan = api.planFirstJob(tenant);
    const result = api.applyFirstJob(tenant, plan.plan_digest);
    expect(result.status).toBe('already_configured');
    expect(readAudit().filter((row) => row.event === 'dot_draft_created')).toHaveLength(1);
    expect(readAudit().filter((row) => row.event === 'dot_status_transition')).toHaveLength(1);
    expectNoIdentityOrExecution();
  });
  it('preserves an unrelated real tenant profile', () => {
    authority.withExecutionContext('sovereign_concierge', () =>
      tenantFacade.mutateTenant({
        verb: 'create',
        slug: tenant,
        displayName: 'Unrelated fixture',
        apply: true,
        actor: 'integration-fixture',
      })
    );
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_existing_tenant_not_owned');
    expect(treeSnapshot()).toEqual(before);
    expect(() => api.applyFirstJob(tenant, 'a'.repeat(64))).toThrow(
      'first_job_existing_tenant_not_owned'
    );
    expect(treeSnapshot().filter(([, kind]) => kind !== 'directory')).toEqual(
      before.filter(([, kind]) => kind !== 'directory')
    );
    expect(safeReaddir(path.join(root, 'active/shared/runtime/locks'))).toEqual([]);
  });
  it('preserves a conflicting draft and does not replace its purpose', () => {
    ownedTenant();
    lifecycle.createDraftDotCharter(
      { ...api.diagnosticDraft(tenant), purpose: 'Different purpose' },
      { actor: 'integration-fixture' }
    );
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_charter_conflict');
    expect(treeSnapshot()).toEqual(before);
  });
  it('does not overwrite another mapping for the local principal', () => {
    const conflict = api.planFirstJob('other-fixture').mapping;
    operator(() =>
      io.safeWriteFile(
        path.join(root, policyPath),
        JSON.stringify({ version: 1, mappings: [conflict] })
      )
    );
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_mapping_conflict');
    expect(treeSnapshot()).toEqual(before);
  });
  it('preserves a governed pause and rejects an old reviewed plan', () => {
    const initial = api.planFirstJob(tenant);
    api.applyFirstJob(tenant, initial.plan_digest);
    const ready = api.planFirstJob(tenant);
    lifecycle.transitionDotCharterStatus(dotId, 'paused', { actor: 'integration-fixture' });
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_charter_not_active');
    expect(() => api.applyFirstJob(tenant, ready.plan_digest)).toThrow(
      'first_job_charter_not_active'
    );
    expect(treeSnapshot()).toEqual(before);
    expect(charterFacade.findDotCharter(dotId)?.charter.status).toBe('paused');
    expect(safeExistsSync(path.join(root, charterPath))).toBe(true);
  });
});

function configureTick() {
  const plan = api.planFirstJob(tenant);
  const configured = api.applyFirstJob(tenant, plan.plan_digest);
  put('knowledge/personal/members/owner.json', syntheticFirstJobOwner(tenant));
  vi.stubEnv('KYBERION_SESSION_SECRET', FIRST_JOB_TEST_SESSION_KEY);
  vi.stubEnv('KYBERION_OIDC_ISSUER', FIRST_JOB_TEST_ISSUER);
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
  const token = browser.mintBrowserSessionToken({
    idpIssuer: FIRST_JOB_TEST_ISSUER,
    subject: FIRST_JOB_TEST_SUBJECT,
    ttlSeconds: 1800,
  }).token;
  return { configured, viewer: configured.mapping.viewer, token };
}
async function requestTick() {
  const fixture = configureTick();
  store.reserveConversationTurn(
    fixture.viewer,
    fixture.configured.mapping.exactCommand,
    randomUUID()
  );
  const first = await api.tickFirstJob(tenant);
  expect(first).toMatchObject({
    status: 'supervisor_pass_completed',
    pass_completed: true,
    outcome: 'awaiting_approval',
    next_actor: 'user',
  });
  expect(work.listWorkItems()).toHaveLength(0);
  return fixture;
}
function decideTick(
  fixture: ReturnType<typeof configureTick>,
  decision: 'approved' | 'rejected' = 'approved'
) {
  const session_id = store.conversationRef(fixture.viewer).sessionId;
  const card = approvals.readFirstJobApprovals(fixture.viewer, fixture.token, { session_id })
    .approvals[0];
  expect(card).toBeTruthy();
  approvals.decideFirstJobApproval(fixture.viewer, fixture.token, card.approval_request_id, {
    decision,
    display_digest: card.display_digest,
    session_id,
  });
}

describe(
  'truthful bounded first-job tick with real stores and receipt readback',
  { timeout: 60_000 },
  () => {
    it('runs one pass without a request and reports noop without provisioning work', async () => {
      configureTick();
      const result = await api.tickFirstJob(tenant);
      expect(result).toMatchObject({
        outcome: 'noop',
        pass_completed: true,
        stages: { housekeeping: 'completed', intake: 'completed', executor: 'completed' },
      });
      expect(work.listWorkItems()).toHaveLength(0);
    });
    it('reports a real signed approval, verified bytes, repeat safety, then a pending revision', async () => {
      const fixture = await requestTick();
      decideTick(fixture);
      const result = await api.tickFirstJob(tenant);
      expect(result).toMatchObject({
        outcome: 'artifact_verified',
        pass_completed: true,
        counts: { settled_actions: 1, executor_done: 1 },
      });
      const item = work.listWorkItems()[0];
      expect(item.status).toBe('done');
      expect(item.attempts).toHaveLength(1);
      const repeat = await api.tickFirstJob(tenant);
      expect(repeat).toMatchObject({
        outcome: 'artifact_verified',
        counts: { settled_actions: 0, executor_done: 0 },
      });
      expect(work.getWorkItem(item.item_id)?.attempts).toHaveLength(1);
      const helper = await import('./onboarding_first_job_tick_status.js');
      const beforeReadback = treeSnapshot();
      expect(
        authority.withExecutionContext(
          'infrastructure_sentinel',
          () =>
            helper.readFirstJobTickStatus(
              charterFacade.findDotCharter(dotId)!.charter,
              fixture.configured.mapping,
              fixture.configured.pipeline_digest
            ),
          'worker',
          tenant
        ).outcome
      ).toBe('artifact_verified');
      expect(treeSnapshot()).toEqual(beforeReadback);
      const artifact = store.readFrontDeskConversationWork(fixture.viewer).tasks[0].artifact!;
      expect(artifact.verification).toBe('verified');
      store.reserveConversationTurn(
        fixture.viewer,
        (
          await import('@agent/core/surface/front-desk-execution-contract')
        ).frontDeskArtifactRevisionCommand('compact'),
        randomUUID(),
        Date.now(),
        undefined,
        {
          requestId: artifact.requestId,
          revision: artifact.revision,
          sha256: artifact.sha256!,
          format: 'compact',
        }
      );
      const revised = await api.tickFirstJob(tenant);
      expect(revised).toMatchObject({
        outcome: 'awaiting_approval',
        outcomes: { artifact_verified: 1, awaiting_approval: 1 },
      });
      expect(work.getWorkItem(item.item_id)?.attempts).toHaveLength(1);
      expect(JSON.stringify(revised)).not.toMatch(
        /artifact_path|PRIVATE_|knowledge\/|active\/|"body"|"summary"/
      );
    });
    it('cannot reuse a success report after actual artifact bytes are altered', async () => {
      const fixture = await requestTick();
      decideTick(fixture);
      expect((await api.tickFirstJob(tenant)).outcome).toBe('artifact_verified');
      const loaded = charterFacade.findDotCharter(dotId)!.charter;
      const results = (await import('@agent/core/dot/dot-executor')).readDotWorkResults(loaded);
      const target = results.at(-1)!.front_desk_verification!.artifact_path;
      operator(() => io.safeWriteFile(target, 'PRIVATE_TAMPERED_BYTES'));
      const result = await api.tickFirstJob(tenant);
      expect(result).toMatchObject({
        outcome: 'uncertain',
        next_actor: 'operator',
        counts: { executor_done: 0 },
      });
      expect(work.listWorkItems()[0].attempts).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_TAMPERED_BYTES');
    });
    it('reports an explicit refusal without creating work', async () => {
      const fixture = await requestTick();
      decideTick(fixture, 'rejected');
      // Rejection distillation is an unrelated asynchronous edge; keep the real
      // settlement/store path while preventing background work after fixture cleanup.
      const housekeeping = dispatch.runDotHousekeeping;
      vi.spyOn(dispatch, 'runDotHousekeeping').mockImplementation((charter, deps) =>
        housekeeping(charter, { ...deps, feedback: { onRejection: () => undefined } })
      );
      expect((await api.tickFirstJob(tenant)).outcome).toBe('refused');
      expect(work.listWorkItems()).toHaveLength(0);
    });
    it('reports an expired pending approval without creating work', async () => {
      await requestTick();
      vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
      expect((await api.tickFirstJob(tenant)).outcome).toBe('expired');
      expect(work.listWorkItems()).toHaveLength(0);
    });
    it('preserves housekeeping errors instead of claiming a healthy pass', async () => {
      configureTick();
      vi.spyOn(dispatch, 'runDotHousekeeping').mockResolvedValueOnce({
        settled: [],
        signals: 0,
        digest: false,
        errors: ['PRIVATE_HOUSEKEEPING /private/path'],
      });
      const result = await api.tickFirstJob(tenant);
      expect(result).toMatchObject({
        status: 'supervisor_pass_failed',
        pass_completed: false,
        outcome: 'failed',
        counts: { housekeeping_errors: 1 },
        stages: { housekeeping: 'failed', executor: 'completed' },
      });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private\/path/);
    });
    it('stops after a throwing stage and never retries or exposes its raw error', async () => {
      configureTick();
      const intake = vi
        .spyOn(execution, 'runFrontDeskExecutionIntake')
        .mockRejectedValueOnce(Error('PRIVATE_INTAKE /private/path'));
      const execute = vi.spyOn(executor, 'runDotExecutorStep');
      const result = await api.tickFirstJob(tenant);
      expect(result).toMatchObject({
        status: 'supervisor_pass_failed',
        pass_completed: false,
        outcome: 'uncertain',
        stages: { intake: 'failed', executor: 'not_run' },
      });
      expect(intake).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private\/path/);
    });
    it('never treats a mocked executor success as artifact evidence', async () => {
      const fixture = await requestTick();
      decideTick(fixture);
      const execute = vi.spyOn(executor, 'runDotExecutorStep').mockResolvedValueOnce([
        {
          dot_id: dotId,
          work_item_id: 'fabricated',
          action_ref: 'fabricated',
          status: 'done',
          mode: 'pipeline',
          summary: 'PRIVATE_SUCCESS',
          started_at: '',
          completed_at: '',
        },
      ]);
      const result = await api.tickFirstJob(tenant);
      expect(result.outcome).not.toBe('artifact_verified');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][2]).toMatchObject({
        scopeToActiveCharters: true,
        assertTenant: expect.any(Function),
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SUCCESS');
    });
    it('observes post-pass configuration revocation instead of a stale success', async () => {
      configureTick();
      vi.spyOn(executor, 'runDotExecutorStep').mockImplementationOnce(async () => {
        put(policyPath, { version: 1, mappings: [] });
        return [];
      });
      expect(await api.tickFirstJob(tenant)).toMatchObject({
        outcome: 'configuration_changed',
        next_action: 'inspect_configuration',
      });
    });
  }
);

describe('first-job CLI tick exit status', { timeout: 60_000 }, () => {
  it.each(['housekeeping', 'intake'] as const)(
    'prints one sanitized JSON payload and exits nonzero for a failed %s pass',
    async (stage) => {
      configureTick();
      if (stage === 'housekeeping') {
        vi.spyOn(dispatch, 'runDotHousekeeping').mockResolvedValueOnce({
          settled: [],
          signals: 0,
          digest: false,
          errors: ['PRIVATE_FAILURE /private/path'],
        });
      } else {
        vi.spyOn(execution, 'runFrontDeskExecutionIntake').mockRejectedValueOnce(
          new Error('PRIVATE_FAILURE /private/path')
        );
      }
      const { runOnboarding } = await import('./onboarding.js');
      const { getProcessExitCode, setProcessExitCode, clearProcessExitCode } =
        await import('./lib/harness.js');
      const previousExitCode = getProcessExitCode();
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        setProcessExitCode(0);
        await runOnboarding(['first-job', '--tenant', tenant, '--tick', '--json']);
        expect(getProcessExitCode()).toBe(1);
        expect(output).toHaveBeenCalledTimes(1);
        const printed = String(output.mock.calls[0][0]);
        expect(JSON.parse(printed)).toMatchObject({
          status: 'supervisor_pass_failed',
          pass_completed: false,
          outcome: stage === 'housekeeping' ? 'failed' : 'uncertain',
        });
        expect(printed).not.toMatch(/PRIVATE_|private\/path|"stack"/);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        clearProcessExitCode();
        if (previousExitCode !== undefined) setProcessExitCode(previousExitCode);
      }
    }
  );
  it.each(['noop', 'awaiting_approval'] as const)(
    'keeps a completed %s pass at exit zero with one JSON payload',
    async (outcome) => {
      const fixture = configureTick();
      if (outcome === 'awaiting_approval') {
        store.reserveConversationTurn(
          fixture.viewer,
          fixture.configured.mapping.exactCommand,
          randomUUID()
        );
      }
      const { runOnboarding } = await import('./onboarding.js');
      const { getProcessExitCode, setProcessExitCode, clearProcessExitCode } =
        await import('./lib/harness.js');
      const previousExitCode = getProcessExitCode();
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        setProcessExitCode(0);
        await runOnboarding(['first-job', '--tenant', tenant, '--tick', '--json']);
        expect(getProcessExitCode()).toBe(0);
        expect(output).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
          status: 'supervisor_pass_completed',
          pass_completed: true,
          outcome,
        });
        expect(errors).not.toHaveBeenCalled();
        expect(work.listWorkItems()).toHaveLength(0);
      } finally {
        clearProcessExitCode();
        if (previousExitCode !== undefined) setProcessExitCode(previousExitCode);
      }
    }
  );
});
