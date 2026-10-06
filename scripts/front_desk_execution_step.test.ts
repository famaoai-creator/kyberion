import * as path from 'node:path';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeMkdir as fixtureMkdir,
  safeWriteFile as fixtureWrite,
  safeRmSync as fixtureRm,
} from '@agent/core/secure-io';
import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
  FIRST_JOB_TEST_SESSION_KEY,
  FIRST_JOB_TEST_ISSUER,
  FIRST_JOB_TEST_SUBJECT,
} from './fixtures/first-job-approval-fixture.js';
import type { FrontDeskExecutionPolicy } from '@agent/core/surface/front-desk-execution-contract';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import type { DotExecutorStepDeps } from './dot_executor_step.js';
const sourceRoot = process.cwd();
const root = path.join(
  sourceRoot,
  'active/shared/tmp',
  'signed-front-desk-execution-' + process.pid
);
const fixture = {
  policy: { version: 1, mappings: [] } as FrontDeskExecutionPolicy,
  charters: [] as LoadedDotCharter[],
};
let reserveConversationTurn: typeof import('@agent/core/surface/front-desk-conversation-store').reserveConversationTurn;
let readConversationHistory: typeof import('@agent/core/surface/front-desk-conversation-store').readConversationHistory;
let readConversationExecutionReports: typeof import('@agent/core/surface/front-desk-conversation-store').readConversationExecutionReports;
let listConfiguredFrontDeskExecutions: typeof import('@agent/core/surface/front-desk-conversation-store').listConfiguredFrontDeskExecutions;
let conversationRef: typeof import('@agent/core/surface/front-desk-conversation-store').conversationRef;
let frontDeskArtifactRevisionCommand: typeof import('@agent/core/surface/front-desk-execution-contract').frontDeskArtifactRevisionCommand;
let FRONT_DESK_RECEIPT_COMMAND: typeof import('@agent/core/surface/front-desk-execution-contract').FRONT_DESK_RECEIPT_COMMAND;
let FRONT_DESK_RECEIPT_PIPELINE: typeof import('@agent/core/surface/front-desk-execution-contract').FRONT_DESK_RECEIPT_PIPELINE;
let runFrontDeskExecutionIntake: typeof import('@agent/core/surface/front-desk-execution').runFrontDeskExecutionIntake;
let prepareFrontDeskExecution: typeof import('@agent/core/surface/front-desk-execution').prepareFrontDeskExecution;
let currentDotActions: typeof import('@agent/core/dot/dot-dispatch').currentDotActions;
let settleDotParkedActions: typeof import('@agent/core/dot/dot-dispatch').settleDotParkedActions;
let approvalRequestLogicalPath: typeof import('@agent/core/governance/approval-store').approvalRequestLogicalPath;
let loadApprovalRequest: typeof import('@agent/core/governance/approval-store').loadApprovalRequest;
let AUTONOMY_APPROVAL_CHANNEL: typeof import('@agent/core/governance/approval-decision-card').AUTONOMY_APPROVAL_CHANNEL;
let getWorkItem: typeof import('@agent/core/workforce/work-coordination').getWorkItem;
let listWorkItems: typeof import('@agent/core/workforce/work-coordination').listWorkItems;
let setWorkCoordinationNamespace: typeof import('@agent/core/workforce/work-coordination').setWorkCoordinationNamespace;
let clearWorkCoordinationNamespace: typeof import('@agent/core/workforce/work-coordination').clearWorkCoordinationNamespace;
let clearWorkCoordinationStore: typeof import('@agent/core/workforce/work-coordination').clearWorkCoordinationStore;
let safeExistsSync: typeof import('@agent/core/secure-io').safeExistsSync;
let safeReadFile: typeof import('@agent/core/secure-io').safeReadFile;
let safeRmSync: typeof import('@agent/core/secure-io').safeRmSync;
let safeWriteFile: typeof import('@agent/core/secure-io').safeWriteFile;
let withExecutionContext: typeof import('@agent/core/authority').withExecutionContext;
let withExecutionContextAsync: typeof import('@agent/core/authority').withExecutionContextAsync;
let mintBrowserSessionToken: typeof import('@agent/core/authn-providers').mintBrowserSessionToken;
let readFirstJobApprovals: typeof import('@agent/core/surface/first-job-approval').readFirstJobApprovals;
let decideFirstJobApproval: typeof import('@agent/core/surface/first-job-approval').decideFirstJobApproval;
let runDotExecutorStep: typeof import('./dot_executor_step.js').runDotExecutorStep;
let buildDotExecutorPorts: typeof import('./dot_executor_step.js').buildDotExecutorPorts;
let FRONT_DESK_EXECUTION_SUPERVISOR_STEP: typeof import('./front_desk_execution_step.js').FRONT_DESK_EXECUTION_SUPERVISOR_STEP;
let DOT_SUPERVISOR_STEPS: typeof import('./dot_supervisor_extensions.js').DOT_SUPERVISOR_STEPS;
let createFirstJobTenantStatusAssertion: typeof import('./onboarding_first_job_tenant_status.js').createFirstJobTenantStatusAssertion;
let status: typeof import('@agent/core/surface/front-desk-execution-status');
let originalProjection: typeof import('@agent/core/surface/front-desk-execution-status').projectFrontDeskExecution;
let tenant: string;
let charter: DotCharter;
let requestId: string;
let namespace: string;
let browserToken = '';
let assertTenant: ReturnType<typeof createFirstJobTenantStatusAssertion>;
let executePipeline: ReturnType<typeof vi.fn<NonNullable<DotExecutorStepDeps['executePipeline']>>>;
const viewer = () => fixture.policy.mappings[0].viewer;
function put(relative: string, value: unknown) {
  const file = path.join(root, relative);
  fixtureMkdir(path.dirname(file), { recursive: true });
  fixtureWrite(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const deps = () => ({
  rootDir: root,
  assertTenant,
  notify: () => false,
  audit: () => undefined,
  feedback: { onRejection: () => undefined },
});
const bound = <T>(fn: () => T) =>
  withExecutionContext('infrastructure_sentinel', fn, 'worker', tenant);
const writeFixtureCharter = (value: unknown) =>
  withExecutionContext('dot_lifecycle_writer', () =>
    safeWriteFile(fixture.charters[0].path, JSON.stringify(value))
  );
const prepareReceipt = (...args: Parameters<typeof prepareFrontDeskExecution>) =>
  bound(() => prepareFrontDeskExecution(...args));
function signedDecision(approvalId: string, decision: 'approved' | 'rejected' = 'approved') {
  const session_id = conversationRef(viewer()).sessionId;
  const review = readFirstJobApprovals(viewer(), browserToken, { session_id });
  expect(review.auth.status, JSON.stringify(review)).toBe('ready');
  const card = review.approvals.find((entry) => entry.approval_request_id === approvalId);
  expect(card, JSON.stringify(review)).toBeTruthy();
  const result = decideFirstJobApproval(viewer(), browserToken, approvalId, {
    decision,
    display_digest: card!.display_digest,
    session_id,
  });
  expect(result.diagnosticDecision?.signature).toMatch(/^[a-f0-9]{64}$/);
  return result;
}
beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('MISSION_ID', '');
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_SUDO', '');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  vi.stubEnv('KYBERION_SESSION_SECRET', FIRST_JOB_TEST_SESSION_KEY);
  vi.stubEnv('KYBERION_OIDC_ISSUER', FIRST_JOB_TEST_ISSUER);
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
  vi.resetModules();
  ({
    reserveConversationTurn,
    readConversationHistory,
    readConversationExecutionReports,
    listConfiguredFrontDeskExecutions,
    conversationRef,
  } = await import('@agent/core/surface/front-desk-conversation-store'));
  ({ frontDeskArtifactRevisionCommand, FRONT_DESK_RECEIPT_COMMAND, FRONT_DESK_RECEIPT_PIPELINE } =
    await import('@agent/core/surface/front-desk-execution-contract'));
  ({ runFrontDeskExecutionIntake, prepareFrontDeskExecution } =
    await import('@agent/core/surface/front-desk-execution'));
  ({ currentDotActions, settleDotParkedActions } = await import('@agent/core/dot/dot-dispatch'));
  ({ approvalRequestLogicalPath, loadApprovalRequest } =
    await import('@agent/core/governance/approval-store'));
  ({ AUTONOMY_APPROVAL_CHANNEL } = await import('@agent/core/governance/approval-decision-card'));
  ({
    getWorkItem,
    listWorkItems,
    setWorkCoordinationNamespace,
    clearWorkCoordinationNamespace,
    clearWorkCoordinationStore,
  } = await import('@agent/core/workforce/work-coordination'));
  ({ safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } =
    await import('@agent/core/secure-io'));
  ({ withExecutionContext, withExecutionContextAsync } = await import('@agent/core/authority'));
  ({ mintBrowserSessionToken } = await import('@agent/core/authn-providers'));
  ({ readFirstJobApprovals, decideFirstJobApproval } =
    await import('@agent/core/surface/first-job-approval'));
  ({ runDotExecutorStep, buildDotExecutorPorts } = await import('./dot_executor_step.js'));
  ({ FRONT_DESK_EXECUTION_SUPERVISOR_STEP } = await import('./front_desk_execution_step.js'));
  ({ DOT_SUPERVISOR_STEPS } = await import('./dot_supervisor_extensions.js'));
  ({ createFirstJobTenantStatusAssertion } =
    await import('./onboarding_first_job_tenant_status.js'));
  status = await import('@agent/core/surface/front-desk-execution-status');
  originalProjection = status.projectFrontDeskExecution;
}, 60000);
beforeEach(() => {
  const nonce = randomUUID().slice(0, 8);
  tenant = 'fd-execution-' + nonce;
  requestId = randomUUID();
  namespace = 'fd-execution-' + nonce;
  setWorkCoordinationNamespace(namespace);
  put('knowledge/personal/members/owner.json', syntheticFirstJobOwner(tenant));
  put('knowledge/personal/tenants/' + tenant + '.json', {
    tenant_slug: tenant,
    display_name: 'Synthetic tenant',
    status: 'active',
    assigned_role: 'owner',
  });
  browserToken = mintBrowserSessionToken({
    idpIssuer: FIRST_JOB_TEST_ISSUER,
    subject: FIRST_JOB_TEST_SUBJECT,
    ttlSeconds: 1800,
  }).token;
  charter = {
    kind: 'dot-charter',
    dot_id: 'fd-executor-' + nonce,
    version: '1.0.0',
    title: 'Diagnostic receipt fixture',
    purpose: 'Synthetic signed request; never installed in production.',
    status: 'active',
    scope: { tier: 'public', tenant_slug: tenant },
    goal: { statement: 'Verify receipt', budget: { wall_clock_ms_per_wake: 30000 } },
    attention: { triggers: [] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: [FRONT_DESK_RECEIPT_PIPELINE],
      max_concurrent_delegations: 2,
    },
    decisions: { default_decision: 'approve' },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: 'fixture', execution_mode: 'front_desk_diagnostic' },
  };
  fixture.charters = [{ charter, path: path.join(root, 'dots', charter.dot_id + '.json') }];
  put('dots/' + charter.dot_id + '.json', charter);
  fixture.policy = {
    version: 1,
    mappings: [
      {
        id: 'receipt-fixture',
        viewer: {
          principalId: 'human:presence-studio-localadmin',
          source: 'loopback',
          role: 'localadmin',
          tenantSlugs: [tenant],
          organizationIds: 'all',
          projectIds: 'all',
          tierAccess: ['public'],
        },
        dotId: charter.dot_id,
        exactCommand: FRONT_DESK_RECEIPT_COMMAND,
        pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: 'receipt-v1' },
      },
    ],
  };
  put('knowledge/product/governance/front-desk-execution-policy.json', fixture.policy);
  assertTenant = createFirstJobTenantStatusAssertion(charter, fixture.policy.mappings[0]);
  vi.spyOn(status, 'projectFrontDeskExecution').mockImplementation((v, b) =>
    originalProjection(v, b, { rootDir: root })
  );
  const realPorts = buildDotExecutorPorts(charter, { rootDir: root, assertTenant });
  executePipeline = vi.fn((ref, context) => realPorts.runPipeline(ref, context));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  fixtureRm(path.join(root, 'active'), { recursive: true, force: true });
  fixtureRm(path.join(root, 'dots'), { recursive: true, force: true });
  fixtureRm(path.join(root, 'knowledge/personal'), { recursive: true, force: true });
  fixture.policy = { version: 1, mappings: [] };
  fixture.charters = [];
});
afterAll(() => {
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  fixtureRm(root, { recursive: true, force: true });
});

async function admitAndApprove() {
  const turn = reserveConversationTurn(viewer(), FRONT_DESK_RECEIPT_COMMAND, requestId);
  expect(turn.routing?.authority).toBe('none');
  expect(listWorkItems()).toHaveLength(0);
  await runFrontDeskExecutionIntake(fixture.charters, deps());
  const action = currentDotActions(charter.dot_id, deps()).at(-1)!;
  expect(action.status).toBe('parked');
  expect(action.request_id).toBeTruthy();
  expect(listWorkItems()).toHaveLength(0);
  const approval = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, action.request_id!)!;
  expect(approval.scope?.viewer_principal).toBe(viewer().principalId);
  signedDecision(approval.id);
  bound(() => settleDotParkedActions(charter, deps()));
  const binding = listConfiguredFrontDeskExecutions()[0].binding;
  const item = getWorkItem(binding.work_item_id)!;
  expect(item.status).toBe('ready');
  return { binding, item };
}
function runExecutor(extra = {}) {
  return withExecutionContextAsync(
    'infrastructure_sentinel',
    () =>
      runDotExecutorStep(new Date(), fixture.charters, {
        ...deps(),
        executePipeline,
        throttle: () => 'normal',
        tokenCapReached: () => false,
        scopeToActiveCharters: true,
        ...extra,
      }),
    'worker',
    tenant
  );
}

async function resumeInFreshProcess(): Promise<Array<{ status: string }>> {
  // All imports use the current build in this process (never mixed source/dist registries).
  // The only fixture adapter replaces the disabled policy READ, not any authorization gate.
  const code = [
    "import { setWorkCoordinationNamespace } from '@agent/core/workforce/work-coordination';",
    "import { withExecutionContextAsync } from '@agent/core/authority';",
    'import { runDotExecutorStep } from ' +
      JSON.stringify(path.join(sourceRoot, 'dist/scripts/dot_executor_step.js')) +
      ';',
    'import { createFirstJobTenantStatusAssertion } from ' +
      JSON.stringify(path.join(sourceRoot, 'dist/scripts/onboarding_first_job_tenant_status.js')) +
      ';',
    'const active = ' + JSON.stringify(fixture.charters) + ';',
    'const mapping = ' + JSON.stringify(fixture.policy.mappings[0]) + ';',
    'setWorkCoordinationNamespace(' + JSON.stringify(namespace) + ');',
    'const assertTenant = createFirstJobTenantStatusAssertion(active[0].charter,mapping);',
    'const rows = await withExecutionContextAsync("infrastructure_sentinel",()=>runDotExecutorStep(new Date(),active,{rootDir:' +
      JSON.stringify(root) +
      ',scopeToActiveCharters:true,assertTenant,throttle:()=>"normal",tokenCapReached:()=>false,appendInbox:()=>undefined,audit:()=>undefined}),"worker",' +
      JSON.stringify(tenant) +
      ');',
    'process.stdout.write("FD_RESTART_RESULT:"+JSON.stringify(rows)+"\\n");',
  ].join('\n');
  const handle = spawnManagedProcess({
    resourceId: 'fd-restart-' + randomUUID(),
    kind: 'service',
    ownerId: namespace,
    ownerType: 'test',
    command: process.execPath,
    args: ['--input-type=module', '-e', code],
    spawnOptions: {
      cwd: root,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  });
  let stdout = '';
  let stderr = '';
  handle.child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  handle.child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopManagedProcess(handle.resourceId, handle.child);
      reject(new Error('restart timeout: ' + stdout + stderr));
    }, 45000);
    handle.child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    handle.child.once('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((line) => line.startsWith('FD_RESTART_RESULT:'));
      if (code !== 0 || !line) reject(new Error('restart failed: ' + stdout + stderr));
      else resolve(JSON.parse(line.slice('FD_RESTART_RESULT:'.length)));
    });
  });
}

describe('durable diagnostic intake vertical slice', () => {
  it.each(['inactive', 'tenant', 'organization', 'project', 'unbound'] as const)(
    'filters %s mapping before any transcript read',
    async (change) => {
      reserveConversationTurn(viewer(), FRONT_DESK_RECEIPT_COMMAND, requestId);
      const reader = vi.spyOn(
        await import('@agent/core/workforce/artifact-store'),
        'readGovernedArtifactJson'
      );
      const c = structuredClone(charter);
      if (change === 'inactive') c.status = 'paused';
      if (change === 'tenant') c.scope.tenant_slug = 'another-tenant';
      if (change === 'organization') c.scope.organization_id = 'another-organization';
      if (change === 'project') c.scope.project_id = 'another-project';
      const options = { ...deps(), assertTenant: change === 'unbound' ? undefined : assertTenant };
      await runFrontDeskExecutionIntake([{ ...fixture.charters[0], charter: c }], options);
      expect(reader).not.toHaveBeenCalled();
      expect(currentDotActions(charter.dot_id, deps())).toHaveLength(0);
      expect(listWorkItems()).toHaveLength(0);
    }
  );
  it('preserves an unsigned legacy approved record without settlement, feedback or WorkItem creation', async () => {
    reserveConversationTurn(viewer(), FRONT_DESK_RECEIPT_COMMAND, requestId);
    await runFrontDeskExecutionIntake(fixture.charters, deps());
    const action = currentDotActions(charter.dot_id, deps()).at(-1)!;
    expect(action.status, action.reason).toBe('parked');
    const approval = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, action.request_id!)!;
    const recordPath = approvalRequestLogicalPath(AUTONOMY_APPROVAL_CHANNEL, approval.id);
    put(recordPath, {
      ...approval,
      status: 'approved',
      decidedBy: 'user:owner',
      decidedByType: 'human',
      authenticated: true,
      decidedAuthMethod: 'manual',
    });
    const ledgerPath = path.join(root, 'active/shared/runtime/dot-action-ledger.jsonl');
    const beforeApproval = safeReadFile(path.join(root, recordPath));
    const beforeLedger = safeReadFile(ledgerPath);
    expect(bound(() => settleDotParkedActions(charter, deps()))).toEqual([]);
    expect(listWorkItems()).toEqual([]);
    expect(safeReadFile(path.join(root, recordPath))).toBe(beforeApproval);
    expect(safeReadFile(ledgerPath)).toBe(beforeLedger);
    expect(executePipeline).not.toHaveBeenCalled();
  });
  it('refuses executor preparation if a formerly signed approval loses its proof', async () => {
    const { item } = await admitAndApprove();
    const approval = loadApprovalRequest(
      AUTONOMY_APPROVAL_CHANNEL,
      String(item.metadata?.approval_request_id)
    )!;
    const { diagnosticDecision: _proof, ...unsigned } = approval;
    put(approvalRequestLogicalPath(AUTONOMY_APPROVAL_CHANNEL, approval.id), unsigned);
    expect(() => prepareReceipt(charter, item, deps())).toThrow(
      'verified first-job human approval required'
    );
    expect((await runExecutor())[0].status).toBe('blocked');
    expect(executePipeline).not.toHaveBeenCalled();
  });
  it('does not publish a signed result if its authenticated owner is revoked while the pipeline runs', async () => {
    const { item } = await admitAndApprove();
    const prepared = prepareReceipt(charter, item, deps());
    const run = executePipeline.getMockImplementation()!;
    executePipeline.mockImplementationOnce(async (...args) => {
      const result = await run(...args);
      put('knowledge/personal/members/owner.json', {
        ...syntheticFirstJobOwner(tenant),
        status: 'suspended',
      });
      return result;
    });
    const rows = await runExecutor();
    expect(rows[0].status).toBe('blocked');
    expect(rows[0].summary).toContain('verified first-job human approval required');
    expect(rows[0].front_desk_verification).toBeUndefined();
    expect(safeExistsSync(prepared.artifactPath)).toBe(false);
  });

  it('uses a live authorization clock when the signed session expires during a frozen-clock sweep', async () => {
    const { item } = await admitAndApprove();
    const prepared = prepareReceipt(charter, item, deps());
    const approvedAt = new Date();
    const approval = loadApprovalRequest(
      AUTONOMY_APPROVAL_CHANNEL,
      String(item.metadata?.approval_request_id)
    )!;
    const deadline = Math.min(
      Date.parse(approval.expiresAt!),
      Date.parse(approval.diagnosticDecision!.session_expires_at)
    );
    const run = executePipeline.getMockImplementation()!;
    executePipeline.mockImplementationOnce(async (...args) => {
      const result = await run(...args);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(deadline + 1);
      return result;
    });
    const rows = await runExecutor({ now: () => approvedAt });
    expect(rows[0].status).toBe('blocked');
    expect(rows[0].summary).toMatch(/human approval required/);
    expect(rows[0].front_desk_verification).toBeUndefined();
    expect(safeExistsSync(prepared.outputPath)).toBe(true);
    expect(safeExistsSync(prepared.artifactPath)).toBe(false);
  });
  it('does not settle an expired signed decision even when the caller supplies an earlier clock', async () => {
    reserveConversationTurn(viewer(), FRONT_DESK_RECEIPT_COMMAND, requestId);
    await runFrontDeskExecutionIntake(fixture.charters, deps());
    const action = currentDotActions(charter.dot_id, deps()).at(-1)!;
    const approvedAt = new Date();
    const approval = signedDecision(action.request_id!);
    const deadline = Math.min(
      Date.parse(approval.expiresAt!),
      Date.parse(approval.diagnosticDecision!.session_expires_at)
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(deadline + 1);
    expect(
      bound(() => settleDotParkedActions(charter, { ...deps(), now: () => approvedAt }))
    ).toEqual([]);
    expect(currentDotActions(charter.dot_id, deps()).at(-1)?.status).toBe('parked');
    expect(listWorkItems()).toHaveLength(0);
  });
  it('does not resolve a provider or execute provenance-bound work after a fresh generic charter reload', async () => {
    const { item } = await admitAndApprove();
    const generic = structuredClone(charter);
    delete generic.runtime.execution_mode;
    generic.attention.triggers = [{ kind: 'cron', cron: '0 9 * * *' }];
    writeFixtureCharter(generic);
    fixture.charters = [{ ...fixture.charters[0], charter: generic }];
    const before = getWorkItem(item.item_id);
    const provider = vi
      .spyOn(await import('@agent/core/reasoning/reasoning-backend'), 'getReasoningBackend')
      .mockImplementation(() => {
        throw new Error('provider resolution forbidden');
      });
    const rows = await runExecutor();
    expect(provider).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].summary).toContain('diagnostic provenance');
    expect(getWorkItem(item.item_id)).toEqual(before);
    expect(executePipeline).not.toHaveBeenCalled();
    expect(() => prepareReceipt(generic, item, deps())).toThrow();
  });
  it('keeps signed parked work inert after its diagnostic mode is removed', async () => {
    reserveConversationTurn(viewer(), FRONT_DESK_RECEIPT_COMMAND, requestId);
    await runFrontDeskExecutionIntake(fixture.charters, deps());
    const action = currentDotActions(charter.dot_id, deps()).at(-1)!;
    signedDecision(action.request_id!);
    const generic = structuredClone(charter);
    delete generic.runtime.execution_mode;
    generic.attention.triggers = [{ kind: 'cron', cron: '0 9 * * *' }];
    writeFixtureCharter(generic);
    expect(bound(() => settleDotParkedActions(generic, deps()))).toEqual([]);
    expect(currentDotActions(charter.dot_id, deps()).at(-1)?.status).toBe('parked');
    expect(listWorkItems()).toHaveLength(0);
  });
  it('registers the supervised producer before the existing executor', () => {
    expect(DOT_SUPERVISOR_STEPS).toContain(FRONT_DESK_EXECUTION_SUPERVISOR_STEP);
    expect(
      DOT_SUPERVISOR_STEPS.findIndex((s) => s.id === FRONT_DESK_EXECUTION_SUPERVISOR_STEP.id)
    ).toBeLessThan(DOT_SUPERVISOR_STEPS.findIndex((s) => s.id === 'dot-executor'));
  });
  it('runs actual pipeline, verifies artifact, and durably reports once after duplicate/restart reads', async () => {
    const { binding, item } = await admitAndApprove();
    const prepared = prepareReceipt(charter, item, deps());
    const rows = await runExecutor();
    expect(rows, JSON.stringify(rows)).toMatchObject([
      {
        status: 'done',
        front_desk_verification: { request_digest: binding.request_digest, revision: 1 },
      },
    ]);
    expect(safeReadFile(prepared.artifactPath)).toBe(prepared.expectedContent);
    expect(getWorkItem(item.item_id)?.status).toBe('done');
    expect(
      readConversationHistory(viewer()).messages.some((message) =>
        message.text.includes(prepared.artifactPath)
      )
    ).toBe(true);
    expect(readConversationExecutionReports(viewer())).toHaveLength(1);
    reserveConversationTurn(viewer(), FRONT_DESK_RECEIPT_COMMAND, requestId);
    await runFrontDeskExecutionIntake(fixture.charters, deps());
    await runExecutor();
    expect(listWorkItems()).toHaveLength(1);
    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(readConversationExecutionReports(viewer())).toHaveLength(1);
    expect(
      readConversationHistory({ ...viewer(), principalId: 'human:other' }).messages
    ).toHaveLength(0);
    expect(
      originalProjection({ ...viewer(), projectIds: ['other'] }, binding, { rootDir: root })
    ).toBeUndefined();
  }, 60000);
  it('resumes an approved durable request in a fresh executor process and does not repeat it on another restart', async () => {
    const { item } = await admitAndApprove();
    const restarted = await resumeInFreshProcess();
    expect(restarted, JSON.stringify(restarted)).toMatchObject([{ status: 'done' }]);
    expect(getWorkItem(item.item_id)?.status).toBe('done');
    expect(await resumeInFreshProcess()).toEqual([]);
    expect(readConversationExecutionReports(viewer())).toHaveLength(1);
  }, 120000);
  it('does not admit protected input scopes or silently publish them to public artifacts', async () => {
    fixture.policy.mappings[0].viewer.tierAccess = ['public', 'confidential'];
    put('knowledge/product/governance/front-desk-execution-policy.json', fixture.policy);
    reserveConversationTurn(viewer(), FRONT_DESK_RECEIPT_COMMAND, requestId);
    expect(listConfiguredFrontDeskExecutions()).toEqual([]);
    await runFrontDeskExecutionIntake(fixture.charters, deps());
    await runExecutor();
    expect(listWorkItems()).toEqual([]);
    expect(executePipeline).not.toHaveBeenCalled();
  });
  it('rejects a changed configuration after approval and before any pipeline effect', async () => {
    const { item } = await admitAndApprove();
    fixture.policy.mappings[0].dotId = 'replacement-dot';
    put('knowledge/product/governance/front-desk-execution-policy.json', fixture.policy);
    const rows = await runExecutor();
    expect(rows[0].status).toBe('blocked');
    expect(getWorkItem(item.item_id)?.status).toBe('archived');
    expect(executePipeline).not.toHaveBeenCalled();
  });
  it('quarantines a succeeded step without a matching artifact and never retries it', async () => {
    const { item } = await admitAndApprove();
    executePipeline.mockResolvedValue({
      status: 'succeeded',
      summary: 'model said done, but no artifact',
    });
    expect((await runExecutor())[0].status).toBe('blocked');
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(getWorkItem(item.item_id)?.status).toBe('archived');
  });
  it('rejects cancellation after approval without claiming cancellation of prior effects', async () => {
    await admitAndApprove();
    reserveConversationTurn(viewer(), 'Cancel ' + requestId, randomUUID());
    expect((await runExecutor())[0].status).toBe('blocked');
    expect(executePipeline).not.toHaveBeenCalled();
    expect(listConfiguredFrontDeskExecutions()[0].request.status).toBe('cancel_requested');
  });
  it('recovers result delivery failure without executing the pipeline again', async () => {
    const { item } = await admitAndApprove();
    await runExecutor({
      appendInbox: () => {
        throw new Error('simulated report transport failure');
      },
    });
    expect(getWorkItem(item.item_id)?.status).toBe('done');
    await runExecutor({ appendInbox: () => undefined });
    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(readConversationExecutionReports(viewer())).toHaveLength(1);
  }, 60000);

  it('leaves an approved diagnostic item pending when the general supervisor has no tenant assertion', async () => {
    charter.runtime.execution_mode = 'front_desk_diagnostic';
    charter.attention.triggers = [];
    charter.decisions = { default_decision: 'approve' };
    charter.notification = {
      delivery_mode: 'inbox',
      deliver_to: { surface: 'surface', channel: 'inbox' },
    };
    writeFixtureCharter(charter);
    const { item } = await admitAndApprove();
    const before = getWorkItem(item.item_id);
    expect(await runExecutor({ assertTenant: undefined })).toEqual([]);
    expect(getWorkItem(item.item_id)).toEqual(before);
    expect(executePipeline).not.toHaveBeenCalled();
    expect(readConversationExecutionReports(viewer())).toHaveLength(0);
    const assertTenant = vi.fn(deps().assertTenant);
    expect((await runExecutor({ scopeToActiveCharters: true, assertTenant }))[0].status).toBe(
      'done'
    );
    expect(assertTenant).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        charter,
        proposal: expect.objectContaining({
          front_desk_execution: expect.objectContaining({ work_item_id: item.item_id }),
        }),
      })
    );
  }, 60000);
  it('rechecks diagnostic tenant status before publication after the pipeline returns', async () => {
    charter.runtime.execution_mode = 'front_desk_diagnostic';
    charter.attention.triggers = [];
    charter.decisions = { default_decision: 'approve' };
    charter.notification = {
      delivery_mode: 'inbox',
      deliver_to: { surface: 'surface', channel: 'inbox' },
    };
    writeFixtureCharter(charter);
    const { item } = await admitAndApprove();
    const prepared = prepareReceipt(charter, item, deps());
    expect(() => prepareReceipt(charter, item, { rootDir: root })).toThrow(
      'bounded_first_job_tick'
    );
    const assertTenant = vi.fn(deps().assertTenant);
    const run = executePipeline.getMockImplementation()!;
    executePipeline.mockImplementation(async (ref, ctx, c) => {
      const result = await run(ref, ctx, c);
      put('knowledge/personal/tenants/' + tenant + '.json', {
        tenant_slug: tenant,
        display_name: 'Synthetic tenant',
        status: 'suspended',
        assigned_role: 'owner',
      });
      return result;
    });
    const rows = await runExecutor({ scopeToActiveCharters: true, assertTenant });
    expect(rows[0].status).toBe('blocked');
    expect(rows[0].summary).toContain('first_job_tenant_status_unavailable');
    expect(assertTenant.mock.calls.length).toBeGreaterThan(1);
    expect(safeExistsSync(prepared.artifactPath)).toBe(false);
    expect(rows[0].front_desk_verification).toBeUndefined();
  }, 60000);
  it.each(['paused', 'removed', 'revised'] as const)(
    'does not publish after its persisted diagnostic charter is %s during execution',
    async (change) => {
      charter.runtime.execution_mode = 'front_desk_diagnostic';
      charter.attention.triggers = [];
      charter.decisions = { default_decision: 'approve' };
      charter.notification = {
        delivery_mode: 'inbox',
        deliver_to: { surface: 'surface', channel: 'inbox' },
      };
      writeFixtureCharter(charter);
      const { item } = await admitAndApprove();
      const prepared = prepareReceipt(charter, item, deps());
      const run = executePipeline.getMockImplementation()!;
      executePipeline.mockImplementation(async (ref, context, c) => {
        const result = await run(ref, context, c);
        if (change === 'removed')
          withExecutionContext('dot_lifecycle_writer', () => safeRmSync(fixture.charters[0].path));
        else
          writeFixtureCharter({
            ...charter,
            ...(change === 'paused' ? { status: 'paused' } : { version: 'revised' }),
          });
        return result;
      });
      const result = await runExecutor({ scopeToActiveCharters: true });
      expect(result[0].status).toBe('blocked');
      expect(result[0].summary).toContain('paused, removed or revised');
      expect(safeExistsSync(prepared.artifactPath)).toBe(false);
      expect(result[0].front_desk_verification).toBeUndefined();
      expect(getWorkItem(item.item_id)?.status).toBe('archived');
    },
    60000
  );
  it('does not publish after a request is cancelled while the pipeline is running', async () => {
    const { item } = await admitAndApprove();
    const prepared = prepareReceipt(charter, item, deps());
    const run = executePipeline.getMockImplementation()!;
    executePipeline.mockImplementation(async (ref, context, c) => {
      const result = await run(ref, context, c);
      reserveConversationTurn(viewer(), 'Cancel ' + requestId, randomUUID());
      return result;
    });
    expect((await runExecutor())[0].status).toBe('blocked');
    expect(safeExistsSync(prepared.artifactPath)).toBe(false);
    expect(listConfiguredFrontDeskExecutions()[0].request.status).toBe('cancel_requested');
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(1);
  }, 60000);
  it('does not publish a late pipeline result after its executor deadline', async () => {
    charter.goal.budget!.wall_clock_ms_per_wake = 1000;
    put('dots/' + charter.dot_id + '.json', charter);
    assertTenant = createFirstJobTenantStatusAssertion(charter, fixture.policy.mappings[0]);
    const { item } = await admitAndApprove();
    const prepared = prepareReceipt(charter, item, deps());
    const run = executePipeline.getMockImplementation()!;
    executePipeline.mockImplementation(async (ref, context, c) => {
      const result = await run(ref, context, c);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return result;
    });
    expect((await runExecutor())[0].status).toBe('blocked');
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(safeExistsSync(prepared.artifactPath)).toBe(false);
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(1);
  }, 60000);
  it('does not claim work completed after saved artifact tampering', async () => {
    const { item } = await admitAndApprove();
    const prepared = prepareReceipt(charter, item, deps());
    await runExecutor();
    withExecutionContext('infrastructure_sentinel', () =>
      safeWriteFile(prepared.artifactPath, 'tampered')
    );
    expect(
      originalProjection(viewer(), listConfiguredFrontDeskExecutions()[0].binding, {
        rootDir: root,
      })?.status
    ).toBe('uncertain');
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(1);
  }, 60000);
});

async function queueRevision(format: 'compact' | 'readable' = 'compact') {
  const parent = listConfiguredFrontDeskExecutions().at(-1)!.binding;
  const projection = originalProjection(viewer(), parent, { rootDir: root })!;
  expect(projection.status).toBe('work_completed');
  const input = {
    requestId: parent.request_id,
    revision: parent.revision,
    sha256: projection.artifactSha256!,
    format,
  };
  const id = randomUUID();
  const text = frontDeskArtifactRevisionCommand(format);
  reserveConversationTurn(viewer(), text, id, Date.now(), undefined, input);
  const child = listConfiguredFrontDeskExecutions().at(-1)!.binding;
  await runFrontDeskExecutionIntake(fixture.charters, deps());
  const action = currentDotActions(charter.dot_id, deps()).at(-1)!;
  expect(action.status).toBe('parked');
  expect(action.front_desk_execution).toMatchObject({
    request_id: id,
    parent_sha256: input.sha256,
  });
  expect(getWorkItem(child.work_item_id)).toBeNull();
  return { parent, child, input, id, text, action };
}
function decideRevision(
  action: ReturnType<typeof currentDotActions>[number],
  decision: 'approved' | 'rejected' = 'approved'
) {
  const approval = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, action.request_id!)!;
  signedDecision(approval.id, decision);
  bound(() => settleDotParkedActions(charter, deps()));
}
describe('real immutable artifact feedback regeneration', () => {
  it('resumes the newly approved revision in a fresh process and preserves its parent', async () => {
    const first = await admitAndApprove();
    const v1 = prepareReceipt(charter, first.item, deps());
    await runExecutor();
    const bytes = safeReadFile(v1.artifactPath);
    const revision = await queueRevision();
    decideRevision(revision.action);
    expect((await resumeInFreshProcess())[0]).toMatchObject({ status: 'done' });
    expect(getWorkItem(revision.child.work_item_id)?.status).toBe('done');
    expect(
      readConversationHistory(viewer()).messages.find((m) => m.artifact?.requestId === revision.id)
        ?.artifact?.revision
    ).toBe(2);
    expect(await resumeInFreshProcess()).toEqual([]);
    expect(safeReadFile(v1.artifactPath)).toBe(bytes);
  }, 120000);
  it('quarantines an unknown revision outcome without retry or parent overwrite', async () => {
    const first = await admitAndApprove();
    const v1 = prepareReceipt(charter, first.item, deps());
    await runExecutor();
    const bytes = safeReadFile(v1.artifactPath);
    const revision = await queueRevision();
    decideRevision(revision.action);
    executePipeline.mockRejectedValueOnce(new Error('unknown outcome after starting revision'));
    expect((await runExecutor())[0].status).toBe('blocked');
    await runExecutor();
    readConversationHistory(viewer());
    await runFrontDeskExecutionIntake(fixture.charters, deps());
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(2);
    expect(safeReadFile(v1.artifactPath)).toBe(bytes);
  }, 60000);
  it('recovers a missing revision report without regenerating either version', async () => {
    await admitAndApprove();
    await runExecutor();
    const revision = await queueRevision();
    decideRevision(revision.action);
    await runExecutor({
      appendInbox: () => {
        throw new Error('revision report transport failure');
      },
    });
    expect(getWorkItem(revision.child.work_item_id)?.status).toBe('done');
    await runExecutor({ appendInbox: () => undefined });
    expect(executePipeline).toHaveBeenCalledTimes(2);
    expect(readConversationExecutionReports(viewer())).toHaveLength(2);
  }, 60000);
  it('creates separately approved V2, preserves V1 bytes, returns lineage, and never reruns for retry or report refresh', async () => {
    const first = await admitAndApprove();
    const v1 = prepareReceipt(charter, first.item, deps());
    expect((await runExecutor())[0].status).toBe('done');
    const oldBytes = safeReadFile(v1.artifactPath);
    const revision = await queueRevision();
    expect(listWorkItems()).toHaveLength(1);
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(1);
    decideRevision(revision.action);
    const item = getWorkItem(revision.child.work_item_id)!;
    const v2 = prepareReceipt(charter, item, deps());
    expect(v2.artifactPath).not.toBe(v1.artifactPath);
    expect(v2.outputPath).not.toBe(v1.outputPath);
    expect((await runExecutor())[0]).toMatchObject({
      status: 'done',
      front_desk_verification: { revision: 2 },
    });
    expect(safeReadFile(v1.artifactPath)).toBe(oldBytes);
    expect(safeReadFile(v2.artifactPath)).toBe(v2.expectedContent);
    expect(v2.expectedContent).not.toContain('\n');
    expect(JSON.parse(v2.expectedContent)).toMatchObject({
      parent_request_id: first.binding.request_id,
      parent_sha256: revision.input.sha256,
    });
    const history = readConversationHistory(viewer());
    expect(
      history.messages.find((m) => m.artifact?.requestId === first.binding.request_id)?.artifact
        ?.canRevise
    ).toBe(false);
    expect(
      history.messages.find((m) => m.artifact?.requestId === revision.id)?.artifact
    ).toMatchObject({ revision: 2, format: 'compact', canRevise: true });
    expect(
      reserveConversationTurn(
        viewer(),
        revision.text,
        revision.id,
        Date.now(),
        undefined,
        revision.input
      ).created
    ).toBe(false);
    await runFrontDeskExecutionIntake(fixture.charters, deps());
    await runExecutor();
    readConversationHistory(viewer());
    expect(executePipeline).toHaveBeenCalledTimes(2);
    expect(readConversationExecutionReports(viewer())).toHaveLength(2);
    expect(await resumeInFreshProcess()).toEqual([]);
    expect(safeReadFile(v1.artifactPath)).toBe(oldBytes);
  }, 60000);
  it('rejects new approval without creating or overwriting an artifact', async () => {
    const first = await admitAndApprove();
    const v1 = prepareReceipt(charter, first.item, deps());
    await runExecutor();
    const bytes = safeReadFile(v1.artifactPath);
    const revision = await queueRevision();
    decideRevision(revision.action, 'rejected');
    await runExecutor();
    expect(getWorkItem(revision.child.work_item_id)).toBeNull();
    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(safeReadFile(v1.artifactPath)).toBe(bytes);
  }, 60000);
  it('blocks parent digest mismatch after approval before a second pipeline can run', async () => {
    const first = await admitAndApprove();
    const v1 = prepareReceipt(charter, first.item, deps());
    await runExecutor();
    const revision = await queueRevision();
    decideRevision(revision.action);
    withExecutionContext('infrastructure_sentinel', () =>
      safeWriteFile(v1.artifactPath, 'tampered fixture')
    );
    const results = await runExecutor();
    expect(results[0].status).toBe('blocked');
    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(safeReadFile(v1.artifactPath)).toBe('tampered fixture');
  }, 60000);
  it('rechecks parent bytes after the pipeline and refuses late publication', async () => {
    const first = await admitAndApprove();
    const v1 = prepareReceipt(charter, first.item, deps());
    await runExecutor();
    const revision = await queueRevision();
    decideRevision(revision.action);
    const childItem = getWorkItem(revision.child.work_item_id)!;
    const v2 = prepareReceipt(charter, childItem, deps());
    const real = executePipeline.getMockImplementation()!;
    executePipeline.mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      withExecutionContext('infrastructure_sentinel', () =>
        safeWriteFile(v1.artifactPath, 'changed after execution')
      );
      return result;
    });
    const results = await runExecutor();
    expect(results[0].status).not.toBe('done');
    expect(safeExistsSync(v2.artifactPath)).toBe(false);
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(2);
  }, 60000);
});
