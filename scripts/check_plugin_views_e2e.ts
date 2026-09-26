#!/usr/bin/env node

/**
 * PE-02: end-to-end proof of the Chronos in-process plugin host with a real
 * third-party plugin in a real browser.
 *
 *   1. builds a hermetic Kyberion root under active/shared/tmp/ (package.json,
 *      a copy of knowledge/product, one registered tenant, the fixture plugin
 *      outside the root's plugins/ tree so it is third-party by provenance);
 *   2. installs the fixture through the governed CLI (`plugin_install.js
 *      --tenant`) and approves the pending install request through the
 *      operator CLI (`kyberion_home.js approvals --approve`);
 *   3. starts the built Chronos (`next start`) on a free loopback port with
 *      the plugin host enabled for that tenant and a random localadmin token —
 *      once directly and once with the environment surface_runtime gives every
 *      surface (`SYSTEM_ROLE=chronos_mirror_v2`, RA-03), because a SYSTEM_ROLE
 *      launch used to silently ignore Chronos's in-process role assumptions;
 *   4. drives Playwright Chromium: plugin-views listing -> iframe view ->
 *      click inside the iframe -> host confirmation -> agent action
 *      dispatched; human action -> approval request -> CLI approval ->
 *      Execute in Chronos -> executed once, a second execution refused;
 *   5. asserts on data only: the listing, the frame response headers, what
 *      the sandboxed document observed (opaque origin, blocked network), the
 *      approval records and the audit chain of the hermetic root.
 *
 * The browser, the server and the hermetic root are always cleaned up (also
 * on failure and on the overall timeout). Needs `pnpm build` (dist scripts
 * and the Chronos production build) and Playwright Chromium.
 *
 *   pnpm kyberion check plugin-views-e2e [--keep-root] [--timeout-ms 100000]
 *     [--launch-mode direct|surface-runtime|both]   (default: both, sequentially)
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { approvalRequestLogicalPath } from '@agent/core/approval-store';
import { readJson, readJsonLines } from '@agent/core/foundation';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { pathResolver } from '@agent/core/path-resolver';
import { pluginViewFrameResponseHeaders } from '@agent/core/plugin-view-frame';
import {
  buildSafeExecEnv,
  safeCopyFileSync,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { writeTenantProfile } from '@agent/core/tenant-registry';
import { resolveVocabularyEntry } from '@agent/core/vocabulary-catalog';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const PLUGIN_ID = 'plugin-view-e2e-fixture';
export const VIEW_ID = 'panel';
export const TENANT_SLUG = 'e2e-tenant';
const FIXTURE_SOURCE = `plugins/fixtures/${PLUGIN_ID}`;
const CHRONOS_DIR = 'presence/displays/chronos-mirror-v2';
const VIEWS_ROUTE = '/api/headless/a2ui/plugin-views';
/** Chronos page that renders the plugin-views workspace. */
const VIEWS_PAGE = '/?section=surface';
const DEFAULT_TIMEOUT_MS = 100_000;
const STEP_TIMEOUT_MS = 30_000;
const SERVER_LOG_TAIL_BYTES = 8 * 1024;

export interface E2eStepTiming {
  step: string;
  ms: number;
}

/**
 * How Chronos is launched. `direct` is a plain `next start`; `surface-runtime`
 * adds the environment scripts/surface_runtime.ts injects for every surface
 * (see {@link surfaceRuntimeLaunchEnv}).
 */
export type ChronosLaunchMode = 'direct' | 'surface-runtime';
export const LAUNCH_MODES: readonly ChronosLaunchMode[] = ['direct', 'surface-runtime'];

export interface PluginViewsE2eModeReport {
  launch_mode: ChronosLaunchMode;
  approval_request_id: string;
  steps: E2eStepTiming[];
  total_ms: number;
}

export interface PluginViewsE2eReport {
  schema: 'pe-02-plugin-views-e2e/v2';
  passed: true;
  plugin_id: string;
  tenant: string;
  runs: PluginViewsE2eModeReport[];
  total_ms: number;
}

/**
 * The environment a Chronos launched by `pnpm surfaces` receives on top of
 * its own: surface_runtime.ts injects `AUTHORIZED_SCOPE=<service id>` and
 * `SYSTEM_ROLE=<surface id with - -> _>`, and the `pnpm surfaces` script runs
 * surface_runtime itself with `KYBERION_PERSONA=worker`, which the surface
 * inherits. Kept in sync with those sources by check_plugin_views_e2e.test.ts.
 */
export function surfaceRuntimeLaunchEnv(): Record<string, string> {
  return {
    KYBERION_PERSONA: 'worker',
    AUTHORIZED_SCOPE: 'chronos-mirror-v2',
    SYSTEM_ROLE: 'chronos_mirror_v2',
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface E2eOptions {
  keepRoot: boolean;
  /** Per launch mode. */
  timeoutMs: number;
  launchModes: ChronosLaunchMode[];
}

export function parseE2eArgs(argv: readonly string[]): E2eOptions {
  const options: E2eOptions = {
    keepRoot: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    launchModes: [...LAUNCH_MODES],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep-root') options.keepRoot = true;
    else if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 10_000) {
        throw new ScriptExitError(1, '--timeout-ms needs a number >= 10000');
      }
      options.timeoutMs = value;
      index += 1;
    } else if (arg === '--launch-mode') {
      const value = argv[index + 1];
      if (value === 'both') options.launchModes = [...LAUNCH_MODES];
      else if (LAUNCH_MODES.includes(value as ChronosLaunchMode)) {
        options.launchModes = [value as ChronosLaunchMode];
      } else {
        throw new ScriptExitError(1, '--launch-mode needs direct, surface-runtime or both');
      }
      index += 1;
    }
  }
  return options;
}

/** The last top-level JSON object printed by a CLI (logs may precede it). */
export function parseLastJsonObject(stdout: string): Record<string, unknown> {
  const start = stdout.lastIndexOf('\n{');
  const text = start >= 0 ? stdout.slice(start + 1) : stdout.trim();
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CLI output is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Headers of `actual` that differ from what the frame route must send. */
export function frameHeaderMismatches(
  actual: Record<string, string>,
  expected: Record<string, string> = pluginViewFrameResponseHeaders()
): string[] {
  const lower = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name.toLowerCase(), value])
  );
  return Object.entries(expected)
    .filter(([name, value]) => lower[name.toLowerCase()] !== value)
    .map(([name]) => name);
}

export interface AuditRecordLike {
  action?: string;
  result?: string;
  operation?: string;
  correlationId?: string;
  tenantSlug?: string;
}

/** Audit expectations of one run; returns the unmet ones (empty = pass). */
export function missingAuditEvidence(
  entries: readonly AuditRecordLike[],
  approvalRequestId: string
): string[] {
  const has = (predicate: (entry: AuditRecordLike) => boolean) => entries.some(predicate);
  const missing: string[] = [];
  if (
    !has(
      (e) =>
        e.action === 'plugin_host.activate' &&
        e.result === 'completed' &&
        e.operation === PLUGIN_ID &&
        e.tenantSlug === TENANT_SLUG
    )
  ) {
    missing.push('plugin_host.activate completed');
  }
  const forApproval = (action: string, result: string) =>
    has((e) => e.action === action && e.result === result && e.correlationId === approvalRequestId);
  if (!forApproval('plugin_view.action.started', 'allowed')) {
    missing.push('plugin_view.action.started allowed');
  }
  if (!forApproval('plugin_view.action.execute', 'completed')) {
    missing.push('plugin_view.action.execute completed');
  }
  if (!forApproval('plugin_view.action.execute', 'denied')) {
    missing.push('plugin_view.action.execute denied (second execution)');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Hermetic root
// ---------------------------------------------------------------------------

function copyTree(source: string, destination: string): void {
  safeMkdir(destination, { recursive: true });
  for (const name of safeReaddir(source)) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = safeLstat(from);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) safeCopyFileSync(from, to);
  }
}

function buildHermeticRoot(root: string): { fixture: string } {
  safeMkdir(root, { recursive: true });
  safeWriteFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'kyberion-plugin-views-e2e', private: true }, null, 2)}\n`
  );
  copyTree(pathResolver.knowledge('product'), path.join(root, 'knowledge', 'product'));
  writeTenantProfile(
    {
      tenant_slug: TENANT_SLUG,
      display_name: 'Plugin views E2E tenant',
      status: 'active',
      assigned_role: 'operator',
    },
    { rootDir: root }
  );
  // Outside the hermetic root's plugins/ tree: third-party by provenance.
  const fixture = path.join(root, 'vendor', PLUGIN_ID);
  copyTree(pathResolver.rootResolve(FIXTURE_SOURCE), fixture);
  return { fixture };
}

function readAuditEntries(root: string): AuditRecordLike[] {
  const dir = path.join(root, 'active', 'shared', 'logs', 'audit');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => /^audit-.*\.jsonl$/u.test(name))
    .flatMap((name) => readJsonLines<AuditRecordLike>(path.join(dir, name)));
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

function runKyberionCli(root: string, script: string, args: string[]): string {
  const result = safeExecResult(
    process.execPath,
    [pathResolver.rootResolve(`dist/scripts/${script}`), ...args],
    {
      cwd: root,
      env: { KYBERION_ROOT: root, KYBERION_REASONING_BACKEND: 'stub' },
      timeoutMs: 60_000,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `${script} ${args.join(' ')} exited ${String(result.status)}: ${result.stderr.slice(-2000)}`
    );
  }
  return result.stdout;
}

function approveViaOperatorCli(root: string, approvalRequestId: string): void {
  runKyberionCli(root, 'kyberion_home.js', ['approvals', '--approve', approvalRequestId]);
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

interface ChronosServer {
  baseUrl: string;
  logTail(): string;
  exited(): boolean;
  stop(): Promise<void>;
}

function startChronos(
  root: string,
  port: number,
  token: string,
  launchMode: ChronosLaunchMode
): ChronosServer {
  const resourceId = `plugin-views-e2e-chronos-${port}`;
  const { child } = spawnManagedProcess({
    resourceId,
    kind: 'ui',
    ownerId: 'check:plugin-views-e2e',
    ownerType: 'e2e-check',
    command: process.execPath,
    args: [
      pathResolver.rootResolve(`${CHRONOS_DIR}/node_modules/next/dist/bin/next`),
      'start',
      '-p',
      String(port),
      '-H',
      '127.0.0.1',
    ],
    shutdownPolicy: 'manual',
    spawnOptions: {
      cwd: pathResolver.rootResolve(CHRONOS_DIR),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildSafeExecEnv({
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        KYBERION_ROOT: root,
        KYBERION_TENANT: TENANT_SLUG,
        KYBERION_VIEWER_SCOPE: 'enforce',
        KYBERION_LOCALADMIN_TOKEN: token,
        KYBERION_LOCALHOST_AUTOADMIN: 'false',
        KYBERION_REASONING_BACKEND: 'stub',
        KYBERION_CHRONOS_PLUGIN_HOST: 'true',
        KYBERION_CHRONOS_PLUGIN_HOST_TENANTS: TENANT_SLUG,
        KYBERION_PLUGIN_HOST_POLL_MS: '1000',
        ...(launchMode === 'surface-runtime' ? surfaceRuntimeLaunchEnv() : {}),
      }),
    },
  });
  let log = '';
  let hasExited = false;
  const append = (chunk: Buffer | string) => {
    log = `${log}${String(chunk)}`.slice(-SERVER_LOG_TAIL_BYTES);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      hasExited = true;
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    logTail: () => log,
    exited: () => hasExited,
    async stop() {
      if (hasExited) return;
      stopManagedProcess(resourceId, child); // SIGTERM
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exitedPromise;
      clearTimeout(killTimer);
    },
  };
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs = STEP_TIMEOUT_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`timed out waiting for ${what}${reason}`);
}

function label(key: string): string {
  const text = resolveVocabularyEntry(key)?.entry?.en;
  if (!text) throw new Error(`vocabulary key ${key} has no English entry`);
  return text;
}

// ---------------------------------------------------------------------------
// Run state: abort (timeout / signal) and teardown
// ---------------------------------------------------------------------------

/**
 * What one run started. `Promise.race` cannot cancel the scenario, so once
 * the run is aborted every step refuses to start (no writes into a removed
 * root) and a server or browser that finishes starting afterwards is torn
 * down at once instead of being adopted.
 */
export class E2eRun {
  aborted = false;
  server?: ChronosServer;
  browser?: Browser;

  assertActive(): void {
    if (this.aborted) throw new Error('the run was aborted');
  }

  async adoptServer(server: ChronosServer): Promise<ChronosServer> {
    if (this.aborted) {
      await server.stop().catch(() => undefined);
      this.assertActive();
    }
    this.server = server;
    return server;
  }

  async adoptBrowser(browser: Browser): Promise<Browser> {
    if (this.aborted) {
      await browser.close().catch(() => undefined);
      this.assertActive();
    }
    this.browser = browser;
    return browser;
  }

  /** Aborts the run and stops what it started (idempotent). */
  async teardown(): Promise<void> {
    this.aborted = true;
    const { browser, server } = this;
    this.browser = undefined;
    // stop() signals the server synchronously, before the first await.
    const serverStopped = server?.stop().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await serverStopped;
  }
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

interface ListingView {
  plugin_id?: string;
  view_id?: string;
  isolation?: string;
  capabilities?: string[];
  actions?: Array<{ id?: string; authority?: string }>;
  frame_url?: string;
}

interface ListingActionRequest {
  approval_request_id?: string;
  action_id?: string;
  status?: string;
  executable?: boolean;
}

interface Listing {
  host?: { enabled?: boolean; plugins?: Array<{ plugin_id?: string; state?: string }> };
  views?: ListingView[];
  action_requests?: ListingActionRequest[];
}

async function readListing(context: BrowserContext, baseUrl: string): Promise<Listing> {
  const response = await context.request.get(`${baseUrl}${VIEWS_ROUTE}`);
  if (!response.ok()) throw new Error(`plugin-views GET ${response.status()}`);
  const body = (await response.json()) as { data?: Listing };
  return body.data ?? {};
}

async function frameValue(page: Page, selector: string, attribute: string): Promise<string> {
  const frame = page.frameLocator(`iframe[src*="plugin_id=${PLUGIN_ID}"]`);
  return (await frame.locator(selector).getAttribute(attribute, { timeout: 2_000 })) ?? '';
}

/** Waits for the frame's reply to its `requestId`-th request and checks its status. */
async function expectFrameResult(page: Page, requestId: string, expected: string): Promise<void> {
  const status = await waitFor(`the frame reply to ${requestId}`, async () =>
    (await frameValue(page, '#result', 'data-request')) === requestId
      ? frameValue(page, '#result', 'data-status')
      : null
  );
  if (status !== expected) {
    throw new Error(`the frame got '${status}' for ${requestId}, expected '${expected}'`);
  }
}

async function confirmInHost(page: Page, actionId: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const text = (await dialog.textContent()) ?? '';
  for (const expected of [`${PLUGIN_ID} / ${VIEW_ID}`, actionId]) {
    if (!text.includes(expected)) {
      throw new Error(`host confirmation does not show '${expected}'`);
    }
  }
  // Allow is armed after a short delay; click waits until it is enabled.
  await dialog
    .getByRole('button', { name: label('plugin:view_frame_confirm_allow'), exact: true })
    .click({ timeout: STEP_TIMEOUT_MS });
  await dialog.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
}

async function scenario(
  root: string,
  timings: E2eStepTiming[],
  run: E2eRun,
  launchMode: ChronosLaunchMode
): Promise<string> {
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    try {
      run.assertActive();
      const value = await fn();
      run.assertActive();
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${name}] ${message}`);
    } finally {
      timings.push({ step: name, ms: Date.now() - started });
    }
  };

  for (const required of [
    `${CHRONOS_DIR}/.next/BUILD_ID`,
    'dist/scripts/plugin_install.js',
    'dist/scripts/kyberion_home.js',
  ]) {
    if (!safeExistsSync(pathResolver.rootResolve(required))) {
      throw new ScriptExitError(1, `missing ${required}: run \`pnpm build\` first`);
    }
  }

  const { fixture } = await step('hermetic-root', () => buildHermeticRoot(root));

  const installApprovalId = await step('governed-install', () => {
    const record = parseLastJsonObject(
      runKyberionCli(root, 'plugin_install.js', [
        '--source',
        fixture,
        '--id',
        PLUGIN_ID,
        '--tenant',
        TENANT_SLUG,
        '--requested-by',
        'plugin-views-e2e',
        '--json',
      ])
    );
    if (record.trust !== 'third-party' || record.activationStatus !== 'pending_approval') {
      throw new Error(
        `expected a pending third-party install, got trust=${String(record.trust)} status=${String(record.activationStatus)}`
      );
    }
    if (typeof record.approvalRequestId !== 'string') throw new Error('no install approval id');
    return record.approvalRequestId;
  });

  await step('approve-install', () => approveViaOperatorCli(root, installApprovalId));

  const token = randomBytes(24).toString('hex');
  const server = await step('start-chronos', async () => {
    // The free port can be taken between probing and listening: retry once.
    for (let attempt = 1; ; attempt += 1) {
      const port = await freeLoopbackPort();
      run.assertActive();
      const started = await run.adoptServer(startChronos(root, port, token, launchMode));
      const state = await waitFor('Chronos /api/healthz', async () => {
        if (started.exited()) return 'exited';
        // Bounded: a port taken by another listener may accept and never answer.
        const response = await fetch(`${started.baseUrl}/api/healthz`, {
          signal: AbortSignal.timeout(2_000),
        }).catch(() => null);
        return response?.ok ? 'ready' : null;
      });
      if (state === 'ready') return started;
      const portInUse = /EADDRINUSE/u.test(started.logTail());
      if (!portInUse || attempt >= 2) {
        throw new Error(`Chronos exited during startup${portInUse ? ' (port in use twice)' : ''}`);
      }
      await started.stop();
    }
  });

  const browser = await step('launch-browser', async () =>
    run.adoptBrowser(await chromium.launch({ headless: true }))
  );
  const context = await browser.newContext({ locale: 'en-US' });
  await context.addCookies([
    {
      name: 'kyberion_token',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);

  const view = await step('list-plugin-views', async () => {
    const listing = await waitFor('the plugin host to activate the fixture', async () => {
      const current = await readListing(context, server.baseUrl);
      const active = current.host?.plugins?.some(
        (plugin) => plugin.plugin_id === PLUGIN_ID && plugin.state === 'active'
      );
      return active ? current : null;
    });
    const found = listing.views?.find(
      (entry) => entry.plugin_id === PLUGIN_ID && entry.view_id === VIEW_ID
    );
    if (
      !found ||
      found.isolation !== 'sandboxed-iframe' ||
      !found.frame_url ||
      !found.capabilities?.includes('action.request')
    ) {
      throw new Error(`fixture view missing or not an iframe view: ${JSON.stringify(found)}`);
    }
    const authorities = Object.fromEntries(
      (found.actions ?? []).map((action) => [action.id, action.authority])
    );
    if (authorities.ping !== 'agent' || authorities.stamp !== 'human') {
      throw new Error(`unexpected action authorities: ${JSON.stringify(authorities)}`);
    }
    return found;
  });

  await step('frame-headers', async () => {
    const response = await context.request.get(`${server.baseUrl}${view.frame_url}`);
    if (response.status() !== 200) throw new Error(`frame GET ${response.status()}`);
    const mismatched = frameHeaderMismatches(response.headers());
    if (mismatched.length > 0) {
      throw new Error(`frame response headers differ: ${mismatched.join(', ')}`);
    }
  });

  const page = await context.newPage();
  await step('open-iframe-view', async () => {
    await page.goto(`${server.baseUrl}${VIEWS_PAGE}`, { waitUntil: 'domcontentloaded' });
    const iframe = page.locator(`iframe[src*="plugin_id=${PLUGIN_ID}"]`);
    await iframe.waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    await iframe.scrollIntoViewIfNeeded();
    const sandbox = await iframe.getAttribute('sandbox');
    if (sandbox !== 'allow-scripts') throw new Error(`iframe sandbox is '${String(sandbox)}'`);
    // What the sandboxed document itself observed.
    await waitFor(
      'the frame handshake',
      async () => (await frameValue(page, '#init', 'data-value')) === 'en'
    );
    const origin = await frameValue(page, '#origin', 'data-value');
    if (origin !== 'null') throw new Error(`frame origin is '${origin}', expected opaque`);
    await waitFor(
      'the frame network probe to be blocked',
      async () => (await frameValue(page, '#network', 'data-value')) === 'blocked'
    );
    await waitFor(
      'the frame CSP to report the connect-src violation',
      async () => (await frameValue(page, '#csp', 'data-value')) === 'connect-src'
    );
  });

  const frame = page.frameLocator(`iframe[src*="plugin_id=${PLUGIN_ID}"]`);
  await step('agent-action', async () => {
    await frame.locator('#ping').click();
    await confirmInHost(page, 'ping');
    await expectFrameResult(page, 'r1', 'dispatched');
  });

  const approvalRequestId = await step('human-action-request', async () => {
    await frame.locator('#stamp').click();
    await confirmInHost(page, 'stamp');
    await expectFrameResult(page, 'r2', 'approval_required');
    const request = await waitFor('the queued action request', async () =>
      (await readListing(context, server.baseUrl)).action_requests?.find(
        (entry) => entry.action_id === 'stamp' && entry.status === 'pending'
      )
    );
    if (!request.approval_request_id) throw new Error('action request has no approval id');
    return request.approval_request_id;
  });

  await step('approve-action', async () => {
    approveViaOperatorCli(root, approvalRequestId);
    await waitFor('the action request to become executable', async () =>
      (await readListing(context, server.baseUrl)).action_requests?.some(
        (entry) =>
          entry.approval_request_id === approvalRequestId &&
          entry.status === 'approved' &&
          entry.executable === true
      )
    );
  });

  await step('execute-once', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page
      .getByText(`${PLUGIN_ID} / ${VIEW_ID} / stamp`, { exact: true })
      .locator('xpath=..');
    await row
      .getByRole('button', { name: label('plugin:view_action_execute'), exact: true })
      .click({ timeout: STEP_TIMEOUT_MS });
    await waitFor('the action request to be executed', async () =>
      (await readListing(context, server.baseUrl)).action_requests?.some(
        (entry) => entry.approval_request_id === approvalRequestId && entry.status === 'executed'
      )
    );
  });

  await step('second-execution-refused', async () => {
    const response = await context.request.post(`${server.baseUrl}${VIEWS_ROUTE}`, {
      data: {
        plugin_id: PLUGIN_ID,
        view_id: VIEW_ID,
        action_id: 'stamp',
        params: { label: 'e2e-stamp' },
        approval_request_id: approvalRequestId,
      },
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status() !== 409 || body.error !== 'PLUGIN_VIEW_APPROVAL_CONSUMED') {
      throw new Error(
        `second execution returned ${response.status()} ${String(body.error)}, expected 409 PLUGIN_VIEW_APPROVAL_CONSUMED`
      );
    }
  });

  await step('governed-stores', () => {
    const install = readJson<Record<string, unknown>>(
      path.join(root, approvalRequestLogicalPath('plugin-install', installApprovalId))
    );
    if (install.status !== 'approved') throw new Error('install approval is not approved');
    const approval = readJson<Record<string, unknown>>(
      path.join(root, approvalRequestLogicalPath('chronos', approvalRequestId))
    );
    const applyResult = approval.applyResult as { result?: string } | undefined;
    if (
      approval.status !== 'approved' ||
      approval.decidedByType !== 'human' ||
      approval.authenticated !== true ||
      applyResult?.result !== 'success'
    ) {
      throw new Error(`action approval record is not an executed human approval`);
    }
    const missing = missingAuditEvidence(readAuditEntries(root), approvalRequestId);
    if (missing.length > 0) throw new Error(`audit chain lacks: ${missing.join('; ')}`);
  });

  return approvalRequestId;
}

export async function runPluginViewsE2e(argv: string[] = []): Promise<PluginViewsE2eReport> {
  const options = parseE2eArgs(argv);
  const started = Date.now();
  const runs: PluginViewsE2eModeReport[] = [];
  // Sequential: each mode gets its own hermetic root, server and browser.
  for (const launchMode of options.launchModes) {
    runs.push(await runPluginViewsE2eMode(launchMode, options));
  }
  return {
    schema: 'pe-02-plugin-views-e2e/v2',
    passed: true,
    plugin_id: PLUGIN_ID,
    tenant: TENANT_SLUG,
    runs,
    total_ms: Date.now() - started,
  };
}

async function runPluginViewsE2eMode(
  launchMode: ChronosLaunchMode,
  options: E2eOptions
): Promise<PluginViewsE2eModeReport> {
  const runId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const root = pathResolver.sharedTmp(`plugin-views-e2e/${runId}`);
  const timings: E2eStepTiming[] = [];
  const run = new E2eRun();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Ctrl-C / SIGTERM: stop the server and browser, remove the root, then
  // re-raise the signal with its default handling.
  const onSignal = (signal: NodeJS.Signals) => {
    void run.teardown(); // sends the server SIGTERM synchronously
    if (!options.keepRoot) removeRoot(root);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        run.aborted = true;
        reject(new Error(`plugin views E2E timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    });
    const approvalRequestId = await Promise.race([
      scenario(root, timings, run, launchMode),
      timeout,
    ]);
    return {
      launch_mode: launchMode,
      approval_request_id: approvalRequestId,
      steps: timings,
      total_ms: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tail = run.server?.logTail().trim();
    throw new ScriptExitError(
      1,
      [
        `plugin views E2E failed (launch mode ${launchMode}): ${message}`,
        `steps: ${timings.map((entry) => `${entry.step}=${entry.ms}ms`).join(' ')}`,
        ...(tail ? ['--- Chronos log (tail) ---', tail] : []),
      ].join('\n')
    );
  } finally {
    if (timer) clearTimeout(timer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    const server = run.server;
    await run.teardown();
    if (options.keepRoot) {
      if (server && safeExistsSync(root)) {
        safeWriteFile(path.join(root, 'chronos.log'), server.logTail());
      }
    } else {
      removeRoot(root);
    }
  }
}

/** Removes the hermetic root; a failure is reported, never thrown over the run's own error. */
function removeRoot(root: string): void {
  try {
    safeRmSync(root);
  } catch (error) {
    console.warn(
      `[check:plugin-views-e2e] could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export const runCheckPluginViewsE2e = defineScript({
  name: 'check:plugin-views-e2e',
  flags: ['json'],
  async run(context) {
    const report = await runPluginViewsE2e(context.argv);
    context.print(report);
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_plugin_views_e2e.ts') ||
  isDirectScript(import.meta.url, 'check_plugin_views_e2e.js')
)
  void runCheckPluginViewsE2e();
