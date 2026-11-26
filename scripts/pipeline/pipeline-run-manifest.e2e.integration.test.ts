/**
 * Run Manifest end to end (pipeline-run-manifest-model.md §3.3): one v2
 * project-trust approval lets a tenant browser scenario run through the real
 * runner, the real browser actuator (headless Chromium against a loopback
 * page) and the real external-operation gate without any per-step approval.
 *
 * Seams: the run executes in an isolated KYBERION_ROOT fixture, so actuator
 * modules are resolved from the source tree through the scenario op override
 * (module resolution only — it never grants approval). `secret:get` is served
 * a synthetic value (never the OS keychain) and `system:wait` completes at once.
 */
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
} from '../fixtures/first-job-approval-fixture.js';
import {
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir as makeFixtureDir,
  safeRmSync as removeFixture,
} from '@agent/core/secure-io';
import { withExecutionContext as inSourceContext } from '@agent/core/authority';
import { agentExecutionContextEnvNames } from '@agent/core/agent-execution-context';

type Core = {
  safeWriteFile: typeof import('@agent/core/secure-io').safeWriteFile;
  pathResolver: typeof import('@agent/core/path-resolver').pathResolver;
  withExecutionContextAsync: typeof import('@agent/core/authority').withExecutionContextAsync;
  decideApprovalRequest: typeof import('@agent/core/governance/approval-store').decideApprovalRequest;
  loadApprovalRequest: typeof import('@agent/core/governance/approval-store').loadApprovalRequest;
  listApprovalRequests: typeof import('@agent/core/governance/approval-store').listApprovalRequests;
  computeApprovalPresentedDigest: typeof import('@agent/core/governance/approval-presentation').computeApprovalPresentedDigest;
  createProjectTrustApprovalRequest: typeof import('@agent/core/project/project-trust').createProjectTrustApprovalRequest;
  requestPipelineFileTrust: typeof import('@agent/core/pipeline/run-manifest').requestPipelineFileTrust;
  executePipelineFile: typeof import('./pipeline-execution-part-results.js').executePipelineFile;
  closeBrowserSession: (sessionId: string) => Promise<boolean>;
};

const sourceRoot = process.cwd();
const fixtureRoot = path.join(sourceRoot, 'active/shared/tmp', `run-manifest-e2e-${randomUUID()}`);
const TENANT = 'rm-e2e';
const SECRET = `synthetic-${randomUUID().slice(0, 8)}`;
const auditChainKey = Symbol.for('@kyberion/audit-chain');
const sourceAuditChainDescriptor = Object.getOwnPropertyDescriptor(globalThis, auditChainKey);
const browserAvailable = (() => {
  try {
    return safeExistsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

let core: Core;
let disposeOverride: (() => void) | undefined;
let server: http.Server;
let otherServer: http.Server;
let base = '';
let elsewhere = '';
const sessions: string[] = [];
const PROFILES = `active/shared/runtime/browser/profiles/confidential/${TENANT}`;

const FORM = `<!doctype html><html><head><title>Login</title></head><body>
<input id="password" type="password"><button id="submit"
onclick="document.title='Submitted:'+document.getElementById('password').value.length">Go</button>
</body></html>`;

function listen(target: http.Server): Promise<string> {
  return new Promise((resolve) =>
    target.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(target.address() as AddressInfo).port}`)
    )
  );
}

function scenario(sessionId: string, extraSteps: unknown[] = []) {
  return {
    action: 'pipeline',
    name: 'Run manifest e2e',
    version: '1.0.0',
    pipeline_id: 'run-manifest-e2e',
    session_id: sessionId,
    options: {
      keep_alive: true,
      headless: true,
      // A persistent profile inside the run's own tenant partition.
      user_data_dir: `${PROFILES}/${sessionId}`,
      navigation_policy: { allow_private_network: true },
    },
    context: { base, keep_polling: true },
    steps: [
      {
        id: 'password',
        op: 'secret:get',
        params: { service: 'rm-e2e', account: 'approver', export_as: 'pw' },
      },
      { id: 'open', op: 'browser:goto', params: { url: '{{base}}/form' } },
      ...extraSteps,
      {
        id: 'poll',
        op: 'core:while',
        params: {
          condition: { from: 'keep_polling', operator: 'eq', value: true },
          max_iterations: 3,
          pipeline: [
            {
              id: 'probe',
              op: 'browser:evaluate',
              // Static script + args data: the step stays pre-approvable.
              params: {
                script: '(a) => document.title + a.suffix',
                args: { suffix: '{{base}}' },
                export_as: 'probe',
              },
            },
            { id: 'pause', op: 'system:wait', params: { duration_ms: 5 } },
          ],
        },
      },
      { id: 'fill', op: 'browser:fill', params: { selector: '#password', text: '{{pw}}' } },
      {
        id: 'submit',
        op: 'browser:click_first_match',
        params: { selectors: ['#missing', '#submit'] },
      },
      {
        id: 'final',
        op: 'browser:evaluate',
        params: { script: 'document.title', export_as: 'final_title' },
      },
    ],
  };
}

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  core.withExecutionContextAsync('mission_controller', fn, 'ecosystem_architect', TENANT);

function writeScenario(name: string, body: unknown): string {
  const rel = `knowledge/confidential/${TENANT}/scenarios/${name}.json`;
  core.safeWriteFile(core.pathResolver.rootResolve(rel), JSON.stringify(body, null, 2));
  return rel;
}

/** The tenant owner decides on the card it was shown (verified presented digest). */
function approve(requestId: string): void {
  const record = core.loadApprovalRequest('project-trust', requestId)!;
  core.decideApprovalRequest('mission_controller', {
    channel: record.channel,
    storageChannel: record.storageChannel,
    requestId: record.id,
    decision: 'approved',
    decidedBy: 'user:owner',
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    presentedDigest: core.computeApprovalPresentedDigest(record),
  });
}

function externalRequestsOf(runId: string | undefined) {
  return core
    .listApprovalRequests()
    .filter((record) => record.requestedByContext?.pipelineRunId === runId);
}

async function run(rel: string, approvalId: string, options: { hasHuman: boolean }) {
  return asOwner(() =>
    core.executePipelineFile(core.pathResolver.rootResolve(rel), {
      projectTrustApprovalId: approvalId,
      hasHuman: options.hasHuman,
      quiet: true,
      context: { elsewhere_url: `${elsewhere}/other` },
    })
  );
}

beforeAll(async () => {
  if (!browserAvailable) return;
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FORM);
  });
  otherServer = http.createServer((_req, res) => res.end('other'));
  base = await listen(server);
  elsewhere = (await listen(otherServer)).replace('127.0.0.1', 'localhost');

  seedFirstJobTestRoot(sourceRoot, fixtureRoot);
  // The gate binds each browser effect to the op's declared interface.
  const manifestRel = 'libs/actuators/browser-actuator/manifest.json';
  makeFixtureDir(path.dirname(path.join(fixtureRoot, manifestRel)), { recursive: true });
  safeCopyFileSync(path.join(sourceRoot, manifestRel), path.join(fixtureRoot, manifestRel));
  process.chdir(fixtureRoot);
  vi.stubEnv('KYBERION_ROOT', fixtureRoot);
  vi.stubEnv('VITEST', '');
  for (const key of ['MISSION_ID', 'KYBERION_TENANT', 'KYBERION_TASK_ID']) vi.stubEnv(key, '');
  // The attended cases model the owner at a plain terminal: this test may
  // itself run inside an agent harness, whose markers would (rightly) make
  // every run unattended.
  for (const key of agentExecutionContextEnvNames()) vi.stubEnv(key, '');
  expect(Reflect.deleteProperty(globalThis, auditChainKey)).toBe(true);
  vi.resetModules();

  const secureIo = await import('@agent/core/secure-io');
  const { pathResolver } = await import('@agent/core/path-resolver');
  const { withExecutionContextAsync } = await import('@agent/core/authority');
  const approvals = await import('@agent/core/governance/approval-store');
  const { computeApprovalPresentedDigest } =
    await import('@agent/core/governance/approval-presentation');
  const { createProjectTrustApprovalRequest } = await import('@agent/core/project/project-trust');
  const { requestPipelineFileTrust } = await import('@agent/core/pipeline/run-manifest');
  const { registerScenarioOpOverride, resolveActuatorOperation } =
    await import('@agent/core/actuator/actuator-op-registry');
  const { withResolvedOperationInterface } =
    await import('@agent/core/governance/external-operation-runtime');
  const { writeTenantProfile } = await import('@agent/core/organization/tenant-registry');
  const { writeMemberProfile } = await import('@agent/core/organization/member-registry');
  const { mapActuatorDispatchOutputToContext, resolveSemanticActuatorStepKind } =
    await import('./pipeline-execution-part-bootstrap.js');
  const { executePipelineFile } = await import('./pipeline-execution-part-results.js');
  const browser = await import('../../libs/actuators/browser-actuator/src/index.js');
  const { browserRuntimeHelpers } =
    await import('../../libs/actuators/browser-actuator/src/browser-runtime-helpers.js');
  expect(pathResolver.rootDir()).toBe(fixtureRoot);

  core = {
    safeWriteFile: secureIo.safeWriteFile,
    pathResolver,
    withExecutionContextAsync,
    decideApprovalRequest: approvals.decideApprovalRequest,
    loadApprovalRequest: approvals.loadApprovalRequest,
    listApprovalRequests: approvals.listApprovalRequests,
    computeApprovalPresentedDigest,
    createProjectTrustApprovalRequest,
    requestPipelineFileTrust,
    executePipelineFile,
    closeBrowserSession: (sessionId) => browserRuntimeHelpers.closeBrowserSession(sessionId),
  };

  await withExecutionContextAsync(
    'mission_controller',
    async () => {
      secureIo.safeMkdir(pathResolver.shared('runtime'));
      writeTenantProfile({
        tenant_slug: TENANT,
        display_name: 'Run manifest e2e',
        assigned_role: 'owner',
        status: 'active',
      });
      writeMemberProfile(syntheticFirstJobOwner(TENANT));
    },
    'ecosystem_architect'
  );

  disposeOverride = registerScenarioOpOverride({
    resolve: ({ domain, action }) => {
      if (domain === 'browser')
        return {
          // The production SDK dispatch (catalog `actionInput`), exactly as
          // the runner's filesystem path calls it: the pipeline's session and
          // options (navigation_policy for the loopback page) must reach the
          // actuator through it.
          handler: async (op, params, ctx, type) => {
            const result = await withResolvedOperationInterface(
              resolveActuatorOperation('browser', op),
              () => browser.actuator.dispatch(op, params, ctx)
            );
            if (!result.ok) throw new Error(result.error || `browser:${op} failed`);
            return {
              handled: true,
              ctx: mapActuatorDispatchOutputToContext(
                ctx,
                result.output,
                resolveSemanticActuatorStepKind('browser', op, type),
                params
              ),
            };
          },
        };
      if (domain === 'secret' && action === 'get')
        return {
          stepType: 'capture',
          handler: async (_op, params, ctx) => ({
            handled: true,
            ctx: { ...ctx, [String(params.export_as)]: SECRET },
          }),
        };
      if (domain === 'system' && action === 'wait')
        return {
          // The wait itself is not under test: complete it immediately.
          handler: async (_op, _params, ctx) => {
            return { handled: true, ctx };
          },
        };
      return undefined;
    },
  });
}, 120000);

afterAll(async () => {
  if (!browserAvailable) return;
  for (const sessionId of sessions) await core.closeBrowserSession(sessionId).catch(() => false);
  disposeOverride?.();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => otherServer.close(resolve));
  if (sourceAuditChainDescriptor)
    Object.defineProperty(globalThis, auditChainKey, sourceAuditChainDescriptor);
  else Reflect.deleteProperty(globalThis, auditChainKey);
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  inSourceContext('ecosystem_architect', () =>
    removeFixture(fixtureRoot, { recursive: true, force: true })
  );
  vi.resetModules();
}, 60000);

describe.skipIf(!browserAvailable)('run manifest end to end (headless Chromium)', () => {
  const session = () => {
    const id = `rm-e2e-${sessions.length}-${randomUUID().slice(0, 6)}`;
    sessions.push(id);
    return id;
  };

  it('runs an approved browser scenario with zero per-step approvals; an edit invalidates it', async () => {
    const rel = await asOwner(async () => writeScenario('approved', scenario(session())));
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({ inputPath: rel, requestedBy: 'pipeline-e2e' })
    );
    expect(request.manifest?.requirements.effects.every((entry) => entry.bindable)).toBe(true);
    // The loosened navigation fence is on the card the owner approves.
    expect(request.record.details).toContain('allows private-network navigation');
    expect(request.record.details).toContain(`uses the persistent profile ${PROFILES}/`);
    await asOwner(async () => approve(request.record.id));

    const result = await run(rel, request.record.id, { hasHuman: true });
    expect(result.status, JSON.stringify(result.results)).toBe('succeeded');
    expect(result.context.final_title).toBe(`Submitted:${SECRET.length}`);
    expect(String(result.context.probe)).toBe(`Login${base}`);
    expect(externalRequestsOf(result.runId)).toEqual([]);

    // (b) One changed byte: the approval and its manifest no longer apply.
    await asOwner(async () =>
      writeScenario('approved', {
        ...scenario(sessions.at(-1)!),
        name: 'Run manifest e2e (edited)',
      })
    );
    await expect(run(rel, request.record.id, { hasHuman: true })).rejects.toThrow(
      /TRUST_REQUIRED/u
    );
    // A file-only (v1) approval of the edited content trusts the file but
    // pre-approves nothing: the first external step asks.
    const fileOnly = await asOwner(async () =>
      core.createProjectTrustApprovalRequest({ inputPath: rel, requestedBy: 'pipeline-e2e' })
    );
    await asOwner(async () => approve(fileOnly.id));
    const unbound = await run(rel, fileOnly.id, { hasHuman: true });
    expect(unbound.status).toBe('suspended');
    const asked = externalRequestsOf(unbound.runId);
    expect(asked).toHaveLength(1);
    expect(asked[0].requestedByContext?.stepId).toBe('open');
  }, 180000);

  it('asks exactly once for a step outside the approved manifest', async () => {
    const injected = { id: 'elsewhere', op: 'browser:goto', params: { url: '{{elsewhere_url}}' } };
    const rel = await asOwner(async () =>
      writeScenario('injected', scenario(session(), [injected]))
    );
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({ inputPath: rel, requestedBy: 'pipeline-e2e' })
    );
    expect(
      request.manifest?.requirements.effects.find((entry) => entry.entry_id === '2')
    ).toMatchObject({ bindable: false, unbindable_reason: 'templated_host' });
    await asOwner(async () => approve(request.record.id));

    const result = await run(rel, request.record.id, { hasHuman: true });
    expect(result.status, JSON.stringify(result.results)).toBe('suspended');
    const asked = externalRequestsOf(result.runId);
    expect(asked).toHaveLength(1);
    expect(asked[0].requestedByContext?.stepId).toBe('elsewhere');
  }, 180000);

  it('keeps the authored options when a step exports over the engine context keys', async () => {
    // Page data written into __pipeline_options / __pipeline_session_id must
    // not change the browser later steps get: the next loopback navigation
    // still runs under the file's navigation policy and session.
    const poison = [
      {
        id: 'poison',
        op: 'browser:evaluate',
        params: { script: '({ headless: false })', export_as: '__pipeline_options' },
      },
      {
        id: 'poison-session',
        op: 'browser:evaluate',
        params: { script: "'attacker-session'", export_as: '__pipeline_session_id' },
      },
      { id: 'reopen', op: 'browser:goto', params: { url: '{{base}}/form' } },
    ];
    const rel = await asOwner(async () => writeScenario('poisoned', scenario(session(), poison)));
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({ inputPath: rel, requestedBy: 'pipeline-e2e' })
    );
    await asOwner(async () => approve(request.record.id));
    const result = await run(rel, request.record.id, { hasHuman: true });
    expect(result.status, JSON.stringify(result.results)).toBe('succeeded');
    expect(result.context.final_title).toBe(`Submitted:${SECRET.length}`);
  }, 180000);

  it('never takes the navigation policy from the caller context', async () => {
    // The file keeps the default fence; the caller tries to lift it.
    const fenced = { ...scenario(session()), options: { keep_alive: true, headless: true } };
    const rel = await asOwner(async () => writeScenario('fenced', fenced));
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({ inputPath: rel, requestedBy: 'pipeline-e2e' })
    );
    expect(request.record.details).not.toContain('private-network');
    await asOwner(async () => approve(request.record.id));

    const result = await asOwner(() =>
      core.executePipelineFile(core.pathResolver.rootResolve(rel), {
        projectTrustApprovalId: request.record.id,
        hasHuman: true,
        quiet: true,
        context: {
          __pipeline_options: { navigation_policy: { allow_private_network: true } },
          __pipeline_session_id: 'caller-chosen-session',
        },
      })
    );
    expect(result.status).not.toBe('succeeded');
    expect(JSON.stringify(result.results)).toContain('BROWSER_NAVIGATION_BLOCKED');
    expect(result.context.final_title).toBeUndefined();
  }, 180000);

  it('admits nothing for an unattended run under an attended-only approval', async () => {
    const rel = await asOwner(async () => writeScenario('attended-only', scenario(session())));
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({ inputPath: rel, requestedBy: 'pipeline-e2e' })
    );
    await asOwner(async () => approve(request.record.id));

    const result = await run(rel, request.record.id, { hasHuman: false });
    expect(result.status).not.toBe('succeeded');
    expect(JSON.stringify(result.results)).toContain('HUMAN_REQUIRED');
    expect(result.context.final_title).toBeUndefined();
    expect(externalRequestsOf(result.runId)).toEqual([]);

    // The owner explicitly enables unattended runs: the same file then runs.
    const unattended = await asOwner(async () =>
      core.requestPipelineFileTrust({
        inputPath: rel,
        allowUnattended: true,
        requestedBy: 'pipeline-e2e',
      })
    );
    expect(unattended.record.summary).toContain('UNATTENDED RUNS ENABLED');
    await asOwner(async () => approve(unattended.record.id));
    const rerun = await run(rel, unattended.record.id, { hasHuman: false });
    expect(rerun.status, JSON.stringify(rerun.results)).toBe('succeeded');
    expect(rerun.context.final_title).toBe(`Submitted:${SECRET.length}`);
  }, 180000);
});
