import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontDeskExecutionPolicy } from '@agent/core/surface/front-desk-execution-contract';
import {
  validateDotCharter,
  type DotCharter,
  type LoadedDotCharter,
} from '@agent/core/dot/dot-charter';
const fixture = vi.hoisted(() => ({
  policy: { version: 1, mappings: [] } as FrontDeskExecutionPolicy,
  charters: [] as LoadedDotCharter[],
}));
vi.mock('@agent/core/foundation/governed-catalog', async (original) => {
  const actual = await original<typeof import('@agent/core/foundation/governed-catalog')>();
  return {
    ...actual,
    defineCatalog: (...args: Parameters<typeof actual.defineCatalog>) => {
      const catalog = actual.defineCatalog(...args);
      return args[0].id === 'front-desk-execution-policy'
        ? { ...catalog, load: () => catalog.validate(fixture.policy) }
        : catalog;
    },
  };
});
vi.mock('@agent/core/dot/dot-charter', async (original) => ({
  ...(await original<typeof import('@agent/core/dot/dot-charter')>()),
  listDotCharters: () => fixture.charters,
}));
import {
  reserveConversationTurn,
  readConversationHistory,
  readConversationExecutionReports,
  listConfiguredFrontDeskExecutions,
  conversationRef,
} from '@agent/core/surface/front-desk-conversation-store';
import {
  frontDeskArtifactRevisionCommand,
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
} from '@agent/core/surface/front-desk-execution-contract';
import {
  runFrontDeskExecutionIntake,
  prepareFrontDeskExecution,
} from '@agent/core/surface/front-desk-execution';
import * as status from '@agent/core/surface/front-desk-execution-status';
import { currentDotActions, settleDotParkedActions } from '@agent/core/dot/dot-dispatch';
import { setDotBudgetThrottleForTests } from '@agent/core/dot/dot-budget';
import {
  approvalStoreRoots,
  decideApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { AUTONOMY_APPROVAL_CHANNEL } from '@agent/core/governance/approval-decision-card';
import {
  getWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
} from '@agent/core/workforce/work-coordination';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { withExecutionContext } from '@agent/core/authority';
import { stubReasoningBackend } from '@agent/core/reasoning/reasoning-backend';
import { executePipelineFile } from './pipeline-execution-part-results.js';
import { runDotExecutorStep, type DotExecutorStepDeps } from './dot_executor_step.js';
import { FRONT_DESK_EXECUTION_SUPERVISOR_STEP } from './front_desk_execution_step.js';
import { DOT_SUPERVISOR_STEPS } from './dot_supervisor_extensions.js';

let root: string;
let tenant: string;
let charter: DotCharter;
let requestId: string;
let namespace: string;
let executePipeline: ReturnType<typeof vi.fn<NonNullable<DotExecutorStepDeps['executePipeline']>>>;
const originalProjection = status.projectFrontDeskExecution;
const viewer = () => fixture.policy.mappings[0].viewer;
const deps = () => ({
  rootDir: root,
  assertTenant: () => undefined,
  notify: () => false,
  audit: () => undefined,
  // Keep the real rejection ledger; the unrelated distillation hook must not
  // write this isolated fixture into the repository-wide feedback store.
  feedback: { onRejection: () => undefined },
});

beforeEach(() => {
  const nonce = randomUUID().slice(0, 8);
  root = 'active/shared/tmp/front-desk-execution-' + nonce;
  tenant = 'fd-execution-' + nonce;
  requestId = randomUUID();
  namespace = 'fd-execution-' + nonce;
  setWorkCoordinationNamespace(namespace);
  setDotBudgetThrottleForTests(() => 'normal');
  charter = {
    kind: 'dot-charter',
    dot_id: 'fd-executor-' + nonce,
    version: '1.0.0',
    title: 'Diagnostic receipt fixture',
    purpose: 'Simulated authorized local test; never installed in production.',
    status: 'active',
    scope: { tier: 'public', tenant_slug: tenant },
    goal: { statement: 'Verify receipt', budget: { wall_clock_ms_per_wake: 30000 } },
    attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: [FRONT_DESK_RECEIPT_PIPELINE],
      max_concurrent_delegations: 2,
    },
    notification: { deliver_to: { surface: 'surface', channel: 'isolated-test' } },
    runtime: { heartbeat_id: 'fixture' },
  };
  validateDotCharter(charter, 'isolated diagnostic fixture');
  fixture.charters = [{ charter, path: root + '/dots/' + charter.dot_id + '.json' }];
  withExecutionContext('infrastructure_sentinel', () =>
    safeWriteFile(fixture.charters[0].path, JSON.stringify(charter))
  );
  fixture.policy = {
    version: 1,
    mappings: [
      {
        id: 'receipt-fixture',
        viewer: {
          principalId: 'human:isolated-fixture',
          role: 'localadmin',
          source: 'loopback',
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
  vi.spyOn(status, 'projectFrontDeskExecution').mockImplementation((v, b) =>
    originalProjection(v, b, { rootDir: root })
  );
  executePipeline = vi.fn(async (ref: string, context: Record<string, unknown>) => {
    const result = await executePipelineFile(ref, {
      context,
      quiet: true,
      hasHuman: false,
      payloadScope: {
        tier: 'public',
        tenant_slug: tenant,
        purpose: 'isolated diagnostic execution test',
      },
    });
    const failed = result.results.some((step) => step.status === 'failed');
    return {
      status: failed ? ('failed' as const) : ('succeeded' as const),
      summary: 'real pipeline fixture',
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  setDotBudgetThrottleForTests(undefined);
  withExecutionContext('infrastructure_sentinel', () => {
    safeRmSync(root, { recursive: true, force: true });
    safeRmSync('active/shared/artifacts/public/' + tenant, { recursive: true, force: true });
    safeRmSync('active/shared/runtime/front-desk-execution/tenants/' + tenant, {
      recursive: true,
      force: true,
    });
    safeRmSync('active/shared/coordination/channels/concierge/conversations/tenants/' + tenant, {
      recursive: true,
      force: true,
    });
    for (const value of Object.values(approvalStoreRoots()))
      safeRmSync(value + '/' + AUTONOMY_APPROVAL_CHANNEL, { recursive: true, force: true });
  });
  fixture.policy = { version: 1, mappings: [] };
  fixture.charters = [];
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
  // Explicit simulated human fixture, not a production human decision.
  decideApprovalRequest('mission_controller', {
    channel: approval.channel,
    storageChannel: approval.storageChannel,
    requestId: approval.id,
    decision: 'approved',
    decidedBy: 'isolated-test-human',
    decidedByRole: 'sovereign',
    decidedByType: 'human',
    authMethod: 'manual',
    authenticated: true,
    effectBinding: approval.accountability?.effectBinding,
  });
  settleDotParkedActions(charter, deps());
  const binding = listConfiguredFrontDeskExecutions()[0].binding;
  const item = getWorkItem(binding.work_item_id)!;
  expect(item.status).toBe('ready');
  return { binding, item };
}
function runExecutor(extra = {}) {
  return runDotExecutorStep(new Date(), fixture.charters, {
    ...deps(),
    backend: stubReasoningBackend,
    executePipeline,
    throttle: () => 'normal',
    tokenCapReached: () => false,
    ...extra,
  });
}

async function resumeInFreshProcess(): Promise<Array<{ status: string }>> {
  // All imports use the current build in this process (never mixed source/dist registries).
  // The only fixture adapter replaces the disabled policy READ, not any authorization gate.
  const code = [
    "import { getFoundationIo, registerFoundationIo } from '@agent/core/foundation/io';",
    "import { setWorkCoordinationNamespace } from '@agent/core/workforce/work-coordination';",
    "import { stubReasoningBackend } from '@agent/core/reasoning/reasoning-backend';",
    "import { runDotExecutorStep } from './dist/scripts/dot_executor_step.js';",
    'const policy = ' + JSON.stringify(fixture.policy) + ';',
    "const base = getFoundationIo(); const matches = p => p.endsWith('/knowledge/product/governance/front-desk-execution-policy.json');",
    'registerFoundationIo({...base, loadJson:(p,o)=>matches(p)?policy:base.loadJson(p,o), loadJsonIfPresent:(p,o)=>matches(p)?policy:base.loadJsonIfPresent(p,o)});',
    'setWorkCoordinationNamespace(' + JSON.stringify(namespace) + ');',
    'const rows = await runDotExecutorStep(new Date(),' +
      JSON.stringify(fixture.charters) +
      ',{rootDir:' +
      JSON.stringify(root) +
      ',backend:stubReasoningBackend,throttle:()=>"normal",tokenCapReached:()=>false,appendInbox:()=>undefined,audit:()=>undefined});',
    'process.stdout.write("FD_RESTART_RESULT:" + JSON.stringify(rows) + "\\n");',
  ].join('\n');
  const handle = spawnManagedProcess({
    resourceId: 'fd-restart-' + randomUUID(),
    kind: 'service',
    ownerId: namespace,
    ownerType: 'test',
    command: process.execPath,
    args: ['--input-type=module', '-e', code],
    spawnOptions: {
      cwd: process.cwd(),
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
  it('registers the supervised producer before the existing executor', () => {
    expect(DOT_SUPERVISOR_STEPS).toContain(FRONT_DESK_EXECUTION_SUPERVISOR_STEP);
    expect(
      DOT_SUPERVISOR_STEPS.findIndex((s) => s.id === FRONT_DESK_EXECUTION_SUPERVISOR_STEP.id)
    ).toBeLessThan(DOT_SUPERVISOR_STEPS.findIndex((s) => s.id === 'dot-executor'));
  });
  it('runs actual pipeline, verifies artifact, and durably reports once after duplicate/restart reads', async () => {
    const { binding, item } = await admitAndApprove();
    const prepared = prepareFrontDeskExecution(charter, item, deps());
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
    expect((await resumeInFreshProcess())[0].status).toBe('done');
    expect(getWorkItem(item.item_id)?.status).toBe('done');
    expect(await resumeInFreshProcess()).toEqual([]);
    expect(readConversationExecutionReports(viewer())).toHaveLength(1);
  }, 120000);
  it('does not admit protected input scopes or silently publish them to public artifacts', async () => {
    fixture.policy.mappings[0].viewer.tierAccess = ['public', 'confidential'];
    charter.scope.tier = 'confidential';
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
  it('does not publish after a request is cancelled while the pipeline is running', async () => {
    const { item } = await admitAndApprove();
    const prepared = prepareFrontDeskExecution(charter, item, deps());
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
    const { item } = await admitAndApprove();
    const prepared = prepareFrontDeskExecution(charter, item, deps());
    charter.goal.budget!.wall_clock_ms_per_wake = 1000;
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
    const prepared = prepareFrontDeskExecution(charter, item, deps());
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
  decideApprovalRequest('mission_controller', {
    channel: approval.channel,
    storageChannel: approval.storageChannel,
    requestId: approval.id,
    decision,
    decidedBy: 'isolated-test-human',
    decidedByRole: 'sovereign',
    decidedByType: 'human',
    authMethod: 'manual',
    authenticated: true,
    effectBinding: approval.accountability?.effectBinding,
  });
  settleDotParkedActions(charter, deps());
}
describe('real immutable artifact feedback regeneration', () => {
  it('resumes the newly approved revision in a fresh process and preserves its parent', async () => {
    const first = await admitAndApprove();
    const v1 = prepareFrontDeskExecution(charter, first.item, deps());
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
    const v1 = prepareFrontDeskExecution(charter, first.item, deps());
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
    const v1 = prepareFrontDeskExecution(charter, first.item, deps());
    expect((await runExecutor())[0].status).toBe('done');
    const oldBytes = safeReadFile(v1.artifactPath);
    const revision = await queueRevision();
    expect(listWorkItems()).toHaveLength(1);
    await runExecutor();
    expect(executePipeline).toHaveBeenCalledTimes(1);
    decideRevision(revision.action);
    const item = getWorkItem(revision.child.work_item_id)!;
    const v2 = prepareFrontDeskExecution(charter, item, deps());
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
    const v1 = prepareFrontDeskExecution(charter, first.item, deps());
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
    const v1 = prepareFrontDeskExecution(charter, first.item, deps());
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
    const v1 = prepareFrontDeskExecution(charter, first.item, deps());
    await runExecutor();
    const revision = await queueRevision();
    decideRevision(revision.action);
    const childItem = getWorkItem(revision.child.work_item_id)!;
    const v2 = prepareFrontDeskExecution(charter, childItem, deps());
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
