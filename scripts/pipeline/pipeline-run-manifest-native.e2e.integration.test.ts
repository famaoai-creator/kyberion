/**
 * Run Manifest end to end for a browser actuator NATIVE pipeline file
 * (pipeline-run-manifest-model.md §3.5): one v2 project-trust approval lets a
 * tenant native scenario (`{action:'pipeline', steps:[{type, op:'goto'}]}`)
 * run through its real entry (`pnpm kyberion browser run --adf`), the real
 * browser actuator (headless Chromium against a loopback page) and the real
 * external-operation gate without any per-step approval; an edited file is
 * not pre-approved and runs exactly as an unapproved native file always has.
 *
 * Seams: the run executes in an isolated KYBERION_ROOT fixture and the entry
 * loads the browser actuator from the source tree instead of dist/.
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

type BrowserModule = typeof import('../../libs/actuators/browser-actuator/src/index.js');
type Core = {
  safeWriteFile: typeof import('@agent/core/secure-io').safeWriteFile;
  pathResolver: typeof import('@agent/core/path-resolver').pathResolver;
  withExecutionContextAsync: typeof import('@agent/core/authority').withExecutionContextAsync;
  resolveRole: typeof import('@agent/core/authority').resolveRole;
  decideApprovalRequest: typeof import('@agent/core/governance/approval-store').decideApprovalRequest;
  loadApprovalRequest: typeof import('@agent/core/governance/approval-store').loadApprovalRequest;
  listApprovalRequests: typeof import('@agent/core/governance/approval-store').listApprovalRequests;
  computeApprovalPresentedDigest: typeof import('@agent/core/governance/approval-presentation').computeApprovalPresentedDigest;
  requestPipelineFileTrust: typeof import('@agent/core/pipeline/run-manifest').requestPipelineFileTrust;
  runBrowserProcedure: typeof import('../run_browser_procedure.js').main;
  browser: BrowserModule;
  closeBrowserSession: (sessionId: string) => Promise<boolean>;
};

const sourceRoot = process.cwd();
const fixtureRoot = path.join(sourceRoot, 'active/shared/tmp', `rm-native-e2e-${randomUUID()}`);
const TENANT = 'rm-native-e2e';
const PASSWORD = `synthetic-${randomUUID().slice(0, 8)}`;
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
let server: http.Server;
let base = '';
const sessions: string[] = [];
const PROFILES = `active/shared/runtime/browser/profiles/confidential/${TENANT}`;

const FORM = `<!doctype html><html><head><title>Login</title></head><body>
<input id="password" type="password"><button id="submit"
onclick="document.title='Submitted:'+document.getElementById('password').value.length">Go</button>
</body></html>`;

/** A native browser pipeline: bare ops, step types, browser if / while bodies. */
function nativeScenario(sessionId: string) {
  return {
    action: 'pipeline',
    session_id: sessionId,
    options: {
      keep_alive: true,
      headless: true,
      user_data_dir: `${PROFILES}/${sessionId}`,
      navigation_policy: { allow_private_network: true },
    },
    context: { base, keep_polling: true, submit: true },
    steps: [
      { type: 'capture', op: 'goto', params: { url: '{{base}}/form' } },
      {
        type: 'control',
        op: 'while',
        params: {
          condition: { from: 'keep_polling', operator: 'eq', value: true },
          max_iterations: 2,
          pipeline: [
            {
              type: 'capture',
              op: 'evaluate',
              params: { script: 'document.title', export_as: 'probe' },
            },
          ],
        },
      },
      // The documented native credential injection: resolved from the
      // process environment, pinned to the page opened at step 0.
      {
        type: 'apply',
        op: 'fill',
        params: { selector: '#password', text: '{{env.RM_NATIVE_PW}}' },
      },
      {
        type: 'capture',
        op: 'screenshot',
        params: { path: `active/shared/tmp/confidential/${TENANT}/browser/${sessionId}.png` },
      },
      {
        type: 'control',
        op: 'if',
        params: {
          condition: { from: 'submit', operator: 'eq', value: true },
          then: [
            {
              type: 'apply',
              op: 'click_first_match',
              params: { selectors: ['#missing', '#submit'] },
            },
          ],
        },
      },
      {
        type: 'capture',
        op: 'evaluate',
        params: { script: 'document.title', export_as: 'final_title' },
      },
    ],
  };
}

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  core.withExecutionContextAsync('mission_controller', fn, 'ecosystem_architect', TENANT);

function writeScenario(name: string, body: unknown): string {
  const rel = `knowledge/confidential/${TENANT}/browser-workflows/scenarios/${name}.json`;
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

/** Every approval request other than the project-trust requests the test opened itself. */
function externalRequests() {
  return core
    .listApprovalRequests()
    .filter(
      (record) => record.storageChannel !== 'project-trust' && record.channel !== 'project-trust'
    );
}

/** The real `pnpm kyberion browser run --adf <file> --json` entry: its printed result. */
/** The browser actuator's pipeline result, as the entry prints it. */
interface BrowserRunResult {
  status?: string;
  results?: unknown[];
  context: Record<string, unknown>;
}

/** The identity each browser dispatch ran under (the run's reads and writes). */
const dispatchRoles: string[] = [];

/** Dispatch the way `browser run --adf` does: always under surface_runtime. */
const asSurface = <T>(fn: () => Promise<T>): Promise<T> =>
  core.withExecutionContextAsync('surface_runtime', () => {
    dispatchRoles.push(core.resolveRole());
    return fn();
  });

async function runEntry(rel: string): Promise<{ result: BrowserRunResult; failed?: string }> {
  const printed: unknown[] = [];
  let failed: string | undefined;
  await asOwner(() =>
    core.runBrowserProcedure(['--adf', rel, '--json'], (value) => printed.push(value), {
      loadActuator: async () => ({
        handleAction: ((input: unknown) => {
          dispatchRoles.push(core.resolveRole());
          return core.browser.handleAction(input as never);
        }) as never,
        runNativePipelineFile: core.browser.runNativePipelineFile as never,
      }),
      missionId: 'MSN-RM-NATIVE-E2E',
    })
  ).catch((error: unknown) => {
    failed = error instanceof Error ? error.message : String(error);
  });
  return { result: JSON.parse(String(printed.at(-1))).result, ...(failed ? { failed } : {}) };
}

beforeAll(async () => {
  if (!browserAvailable) return;
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FORM);
  });
  base = await new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    )
  );

  seedFirstJobTestRoot(sourceRoot, fixtureRoot);
  const manifestRel = 'libs/actuators/browser-actuator/manifest.json';
  makeFixtureDir(path.dirname(path.join(fixtureRoot, manifestRel)), { recursive: true });
  safeCopyFileSync(path.join(sourceRoot, manifestRel), path.join(fixtureRoot, manifestRel));
  process.chdir(fixtureRoot);
  vi.stubEnv('KYBERION_ROOT', fixtureRoot);
  vi.stubEnv('VITEST', '');
  for (const key of ['MISSION_ID', 'KYBERION_TENANT', 'KYBERION_TASK_ID']) vi.stubEnv(key, '');
  vi.stubEnv('RM_NATIVE_PW', PASSWORD);
  // This test may run inside an agent harness; its markers would (rightly)
  // make every run unattended. The approvals below allow unattended runs.
  for (const key of agentExecutionContextEnvNames()) vi.stubEnv(key, '');
  expect(Reflect.deleteProperty(globalThis, auditChainKey)).toBe(true);
  vi.resetModules();

  const secureIo = await import('@agent/core/secure-io');
  const { pathResolver } = await import('@agent/core/path-resolver');
  const { withExecutionContextAsync, resolveRole } = await import('@agent/core/authority');
  const approvals = await import('@agent/core/governance/approval-store');
  const { computeApprovalPresentedDigest } =
    await import('@agent/core/governance/approval-presentation');
  const { requestPipelineFileTrust } = await import('@agent/core/pipeline/run-manifest');
  const { writeTenantProfile } = await import('@agent/core/organization/tenant-registry');
  const { writeMemberProfile } = await import('@agent/core/organization/member-registry');
  const { main: runBrowserProcedure } = await import('../run_browser_procedure.js');
  const browser = await import('../../libs/actuators/browser-actuator/src/index.js');
  const { browserRuntimeHelpers } =
    await import('../../libs/actuators/browser-actuator/src/browser-runtime-helpers.js');
  expect(pathResolver.rootDir()).toBe(fixtureRoot);

  core = {
    safeWriteFile: secureIo.safeWriteFile,
    pathResolver,
    withExecutionContextAsync,
    resolveRole,
    decideApprovalRequest: approvals.decideApprovalRequest,
    loadApprovalRequest: approvals.loadApprovalRequest,
    listApprovalRequests: approvals.listApprovalRequests,
    computeApprovalPresentedDigest,
    requestPipelineFileTrust,
    runBrowserProcedure,
    browser,
    closeBrowserSession: (sessionId) => browserRuntimeHelpers.closeBrowserSession(sessionId),
  };

  await withExecutionContextAsync(
    'mission_controller',
    async () => {
      secureIo.safeMkdir(pathResolver.shared('runtime'));
      writeTenantProfile({
        tenant_slug: TENANT,
        display_name: 'Run manifest native e2e',
        assigned_role: 'owner',
        status: 'active',
      });
      writeMemberProfile(syntheticFirstJobOwner(TENANT));
    },
    'ecosystem_architect'
  );
}, 120000);

afterAll(async () => {
  if (!browserAvailable) return;
  for (const sessionId of sessions) await core.closeBrowserSession(sessionId).catch(() => false);
  await new Promise((resolve) => server.close(resolve));
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

describe.skipIf(!browserAvailable)('run manifest end to end — native browser pipeline', () => {
  const session = () => {
    const id = `rm-native-${sessions.length}-${randomUUID().slice(0, 6)}`;
    sessions.push(id);
    return id;
  };

  it('runs an approved native file with zero per-step approvals; an edit invalidates it', async () => {
    const rel = await asOwner(async () => writeScenario('approved', nativeScenario(session())));
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({
        inputPath: rel,
        allowUnattended: true,
        requestedBy: 'pipeline-native-e2e',
      })
    );
    expect(request.manifest?.source.format).toBe('browser_native');
    expect(
      request.manifest?.requirements.effects.map((entry) => [entry.entry_id, entry.bindable])
    ).toEqual([
      ['0', true],
      ['1.pipeline.0', true],
      ['2', true],
      ['4.then.0', true],
      ['5', true],
    ]);
    expect(request.manifest?.requirements.effects[2]).toMatchObject({
      entry_id: '2',
      secret_origins: { 'env/RM_NATIVE_PW': [base] },
    });
    expect(request.record.details).toContain(
      'Type the value of environment variable RM_NATIVE_PW (credential) into #password on'
    );
    expect(request.record.details).toContain('Runner: the browser actuator');
    expect(request.record.details).toContain(`uses the persistent profile ${PROFILES}/`);
    await asOwner(async () => approve(request.record.id));

    const before = externalRequests().length;
    dispatchRoles.length = 0;
    const { result, failed } = await runEntry(rel);
    expect(failed).toBeUndefined();
    // The bound run dispatched under surface_runtime, not the caller's identity.
    expect(dispatchRoles).toEqual(['surface_runtime']);
    expect(result.status, JSON.stringify(result.results)).toBe('succeeded');
    expect(result.context.final_title).toBe(`Submitted:${PASSWORD.length}`);
    expect(result.context.probe).toBe('Login');
    expect(externalRequests()).toHaveLength(before);

    // One changed byte: the approval no longer applies and the run is the
    // unapproved native run of today — its first external step (the goto)
    // needs its own approval and nothing after it runs.
    await asOwner(async () =>
      writeScenario('approved', { ...nativeScenario(sessions.at(-1)!), _edited: true })
    );
    const edited = await runEntry(rel);
    expect(edited.failed).toContain('adf execution failed');
    expect(edited.result.status).toBe('failed');
    expect(JSON.stringify(edited.result.results)).toContain('EXTERNAL_APPROVAL_REQUIRED');
    expect(edited.result.results).toHaveLength(1);
    expect(edited.result.context?.final_title).toBeUndefined();
  }, 180000);

  it('admits an attended-only approval for the owner at a terminal, never for unattended', async () => {
    const body = nativeScenario(session());
    const rel = await asOwner(async () => writeScenario('attended-only', body));
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({ inputPath: rel, requestedBy: 'pipeline-native-e2e' })
    );
    expect(request.record.summary).not.toContain('UNATTENDED RUNS ENABLED');
    await asOwner(async () => approve(request.record.id));
    const sourceText = JSON.stringify(body, null, 2);
    const runAs = (hasHuman: boolean) =>
      asOwner(() =>
        core.browser.runNativePipelineFile(
          { inputPath: rel, sourceText, pipeline: body },
          () => asSurface(() => core.browser.handleAction(body) as Promise<BrowserRunResult>),
          { hasHuman }
        )
      );

    const before = externalRequests().length;
    const attended = await runAs(true);
    expect(attended.status, JSON.stringify(attended.results)).toBe('succeeded');
    expect(attended.context.final_title).toBe(`Submitted:${PASSWORD.length}`);
    expect(externalRequests()).toHaveLength(before);

    const unattended = await runAs(false);
    expect(unattended.status).toBe('failed');
    expect(JSON.stringify(unattended.results)).toContain('HUMAN_REQUIRED');
    expect(unattended.context.final_title).toBeUndefined();
  }, 180000);

  it('asks per step for a write outside the partition; the earlier steps stay pre-approved', async () => {
    const body = nativeScenario(session());
    const outside = `active/shared/tmp/rm-native-${randomUUID().slice(0, 6)}.png`;
    body.steps.push({ type: 'capture', op: 'screenshot', params: { path: outside } });
    const rel = await asOwner(async () => writeScenario('unconfined-write', body));
    const request = await asOwner(async () =>
      core.requestPipelineFileTrust({ inputPath: rel, requestedBy: 'pipeline-native-e2e' })
    );
    const write = request.manifest?.requirements.effects.find(
      (entry) => entry.operation_id === 'browser:write_file'
    );
    expect(write).toMatchObject({
      entry_id: '6',
      bindable: false,
      unbindable_reason: 'write_path_unconfined',
      write: { path: outside },
    });
    expect(request.record.details).toContain(
      `step 6 writes ${outside} outside the run's partition`
    );
    await asOwner(async () => approve(request.record.id));

    const before = externalRequests().length;
    const sourceText = JSON.stringify(body, null, 2);
    const result = (await asOwner(() =>
      core.browser.runNativePipelineFile(
        { inputPath: rel, sourceText, pipeline: body },
        () => asSurface(() => core.browser.handleAction(body) as Promise<BrowserRunResult>),
        { hasHuman: true }
      )
    )) as BrowserRunResult;
    // Every approved step ran without a prompt; the write asks for its own approval.
    expect(result.context.final_title).toBe(`Submitted:${PASSWORD.length}`);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result.results)).toContain('EXTERNAL_APPROVAL_REQUIRED');
    const asked = externalRequests().slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0].requestedByContext?.stepId).toBe('6');
    expect(JSON.stringify(asked[0])).toContain('browser:write_file');
    expect(safeExistsSync(core.pathResolver.rootResolve(outside))).toBe(false);
  }, 180000);
});
