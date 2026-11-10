/**
 * Shared harness for the Concierge `/api/first-job*` route tests
 * (`src/app/api/first-job/route*.test.ts`). Hermetic: a temporary
 * KYBERION_ROOT (governance, schemas and the receipt pipeline copied in) under
 * SYSTEM_ROLE=concierge. The local-peer proof, the Concierge viewer (a real
 * signed browser session), installation-owner access, the role assumption
 * policy and the path authority of the conversation, approval, dot and work
 * stores are the real ones — a route moved between processes re-checks all
 * of them. The operator steps the person runs in a terminal
 * (`pnpm onboarding first-job --apply`, `--tick`) run standalone, as they do
 * outside the server.
 *
 * Module caches pin the root a file first loaded, and the stores keep their
 * history, so each scenario is its own test file (its own process and root).
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const FIRST_JOB_TENANT = 'first-job-route';
export const HOST = '127.0.0.1:3050';
export const ORIGIN = 'http://' + HOST;
export const OTHER_SUBJECT = 'other-member-subject';
export const SUSPENDED_SUBJECT = 'suspended-member-subject';
const tenant = FIRST_JOB_TENANT;

// The operator CLI and its fixture live in scripts/, outside the Concierge
// type project; they are loaded by path with just the surface used here.
interface Fixture {
  FIRST_JOB_TEST_ISSUER: string;
  FIRST_JOB_TEST_SUBJECT: string;
  FIRST_JOB_TEST_SESSION_KEY: string;
  seedFirstJobTestRoot(sourceRoot: string, root: string): void;
  syntheticFirstJobOwner(tenant: string): Record<string, unknown>;
}
interface Operator {
  planFirstJob(tenant: string): { plan_digest: string };
  applyFirstJob(tenant: string, digest: string): unknown;
  tickFirstJob(tenant: string): Promise<{ outcome: string }>;
}
const loadScript = <T>(relative: string): Promise<T> =>
  import(/* @vite-ignore */ path.join(sourceRoot, relative)) as Promise<T>;

/** The loaded modules and the current credentials of one installation. */
export const fj = {
  root: path.join(sourceRoot, 'active/shared/tmp', `vitest-first-job-${randomUUID()}`),
  fixture: undefined as unknown as Fixture,
  io: undefined as unknown as typeof import('@agent/core'),
  authority: undefined as unknown as typeof import('@agent/core/authority'),
  browser: undefined as unknown as typeof import('@agent/core/authn/authn-providers'),
  work: undefined as unknown as typeof import('@agent/core/workforce/work-coordination'),
  approvals: undefined as unknown as typeof import('@agent/core/governance/approval-store'),
  owner: undefined as unknown as typeof import('@agent/core/surface/installation-owner-access'),
  localPeer: undefined as unknown as typeof import('./local-peer-fixture'),
  operator: undefined as unknown as Operator,
  main: undefined as unknown as typeof import('../src/app/api/first-job/route'),
  approvalList: undefined as unknown as typeof import('../src/app/api/first-job/approvals/route'),
  decision:
    undefined as unknown as typeof import('../src/app/api/first-job/approvals/[requestId]/decision/route'),
  recovery:
    undefined as unknown as typeof import('../src/app/api/first-job/recovery/[requestId]/route'),
  artifact: undefined as unknown as typeof import('../src/app/api/first-job/artifact/route'),
  ownerToken: '',
  otherToken: '',
};

export function mint(subject: string): string {
  return fj.browser.mintBrowserSessionToken({
    idpIssuer: fj.fixture.FIRST_JOB_TEST_ISSUER,
    subject,
    ttlSeconds: 1800,
  }).token;
}

/**
 * The `pnpm onboarding first-job` steps: a standalone operator process (no
 * SYSTEM_ROLE) started from the repository root, as the operator runs them.
 * The receipt executor resolves its pipeline from the working directory, so
 * this relies on the root vitest config's `forks` pool (`process.chdir`
 * throws in worker threads, which would fail loudly rather than silently).
 */
export async function standalone<T>(fn: () => T | Promise<T>): Promise<T> {
  vi.stubEnv('SYSTEM_ROLE', '');
  process.chdir(fj.root);
  try {
    return await fn();
  } finally {
    process.chdir(sourceRoot);
    vi.stubEnv('SYSTEM_ROLE', 'concierge');
  }
}

/** One installation: the root seeded, the routes loaded, the diagnostic applied. */
export async function setUpFirstJob(options: { bound?: boolean } = {}): Promise<void> {
  const bootstrap = await import('@agent/core');
  fj.fixture = await loadScript<Fixture>('scripts/fixtures/first-job-approval-fixture.ts');
  fj.fixture.seedFirstJobTestRoot(sourceRoot, fj.root);
  bootstrap.safeMkdir(path.join(fj.root, 'knowledge/public/common'), { recursive: true });
  bootstrap.safeCopyFileSync(
    path.join(sourceRoot, 'knowledge/public/common/project_standards.json'),
    path.join(fj.root, 'knowledge/public/common/project_standards.json')
  );
  vi.stubEnv('KYBERION_ROOT', fj.root);
  vi.stubEnv('SYSTEM_ROLE', 'concierge');
  for (const key of [
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_PROJECT_ID',
    'KYBERION_SUDO',
    'KYBERION_API_TOKEN',
    'KYBERION_LOCALADMIN_TOKEN',
    'KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_BASE_ROLE', 'worker');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  vi.stubEnv('KYBERION_SESSION_SECRET', fj.fixture.FIRST_JOB_TEST_SESSION_KEY);
  vi.stubEnv('KYBERION_OIDC_ISSUER', fj.fixture.FIRST_JOB_TEST_ISSUER);
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
  vi.resetModules();
  fj.io = await import('@agent/core');
  fj.authority = await import('@agent/core/authority');
  fj.browser = await import('@agent/core/authn/authn-providers');
  fj.work = await import('@agent/core/workforce/work-coordination');
  fj.approvals = await import('@agent/core/governance/approval-store');
  fj.owner = await import('@agent/core/surface/installation-owner-access');
  fj.localPeer = await import('./local-peer-fixture');
  fj.operator = await loadScript<Operator>('scripts/onboarding_first_job.ts');
  fj.main = await import('../src/app/api/first-job/route');
  fj.approvalList = await import('../src/app/api/first-job/approvals/route');
  fj.decision = await import('../src/app/api/first-job/approvals/[requestId]/decision/route');
  fj.recovery = await import('../src/app/api/first-job/recovery/[requestId]/route');
  fj.artifact = await import('../src/app/api/first-job/artifact/route');
  fj.work.setWorkCoordinationNamespace('first-job-route-' + randomUUID());
  const charters = await import('@agent/core/dot/dot-charter');
  const paths = await import('@agent/core/dot/dot-state-paths');
  await standalone(() => {
    const plan = fj.operator.planFirstJob(tenant);
    fj.operator.applyFirstJob(tenant, plan.plan_digest);
    // Earlier, unrelated work and an (empty) executor result log: the
    // recovery proof reads both and fails closed while they do not exist yet.
    fj.authority.withExecutionContext('infrastructure_sentinel', () => {
      const charter = charters.findDotCharter('first-job-' + tenant)!.charter;
      const results = paths.dotStatePath(charter, paths.DOT_WORK_RESULTS_FILE);
      fj.io.safeMkdir(path.dirname(results), { recursive: true });
      fj.io.safeWriteFile(results, '');
      const item = fj.work.createWorkItem({
        itemId: 'unrelated-fixture',
        title: 'Unrelated',
        description: 'Retained unrelated history',
        status: 'ready',
      });
      const claim = fj.work.claimWorkItem({
        itemId: item.item_id,
        actorPeerId: 'fixture',
        purpose: 'Synthetic fixture',
      });
      fj.work.releaseWorkItem({
        itemId: item.item_id,
        leaseId: claim.lease.lease_id,
        actorPeerId: 'fixture',
        nextStatus: 'done',
      });
    });
  });
  if (options.bound !== false) await bindOwner();
  fj.owner.resetInstallationBootstrapCache();
}

/**
 * Register the installation owner (bound to the synthetic IdP subject), a
 * second, equally privileged member who is not the owner of this machine,
 * and a suspended member whose session the viewer itself refuses (403).
 * First-run setup closes for good once an owner can sign in.
 */
export async function bindOwner(): Promise<void> {
  const { fixture } = fj;
  const members = await import('@agent/core/organization/member-registry');
  const member = (id: string, subject: string, status = 'active') => ({
    ...fixture.syntheticFirstJobOwner(tenant),
    member_id: id,
    display_name: id,
    status,
    external_identities: [{ issuer: fixture.FIRST_JOB_TEST_ISSUER, subject }],
  });
  // Through the governed member writer, as the registry's own fixtures do.
  fj.authority.withExecutionContext('sovereign_concierge', () => {
    for (const profile of [
      fixture.syntheticFirstJobOwner(tenant),
      member('other', OTHER_SUBJECT),
      member('suspended', SUSPENDED_SUBJECT, 'suspended'),
    ])
      members.writeMemberProfile(profile as Parameters<typeof members.writeMemberProfile>[0]);
  });
  fj.owner.resetInstallationBootstrapCache();
  fj.ownerToken = mint(fj.fixture.FIRST_JOB_TEST_SUBJECT);
  fj.otherToken = mint(OTHER_SUBJECT);
}

export async function tearDownFirstJob(): Promise<void> {
  fj.work?.clearWorkCoordinationStore();
  fj.work?.clearWorkCoordinationNamespace();
  vi.unstubAllEnvs();
  vi.resetModules();
  const bootstrap = await import('@agent/core');
  bootstrap.safeRmSync(fj.root, { recursive: true, force: true });
}

/** Rotate the browser-session key: every earlier signed decision stops verifying. */
export function rotateSessionKey(): void {
  vi.stubEnv('KYBERION_SESSION_SECRET', 'rotated-synthetic-session-key-for-tests-only-0123');
  fj.ownerToken = mint(fj.fixture.FIRST_JOB_TEST_SUBJECT);
  fj.otherToken = mint(OTHER_SUBJECT);
}

export interface Options {
  /** The local server's attested loopback peer; `false` = no peer proof at all. */
  peer?: boolean;
  host?: string;
  origin?: string | null;
  token?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent verbatim instead of `JSON.stringify(body)`. */
  rawBody?: string;
  /** Appended to the request target (e.g. `?x=1`). */
  query?: string;
}

/**
 * A request as the local Concierge server hands it to Next. The handler runs
 * inside the peer-proof lifetime (`test/local-peer-fixture.ts`).
 */
export function send(
  method: 'GET' | 'POST',
  target: string,
  options: Options,
  handler: (req: NextRequest) => Response | Promise<Response>
): Promise<Response> {
  const headers: Record<string, string> = { host: options.host ?? HOST };
  const origin =
    options.origin === undefined ? (method === 'POST' ? ORIGIN : null) : options.origin;
  if (origin) headers.origin = origin;
  const token = options.token === undefined ? fj.ownerToken : options.token;
  if (token) headers.cookie = 'kyberion_session=' + token;
  if (method === 'POST') headers['content-type'] = 'application/json';
  Object.assign(headers, options.headers);
  const req = new NextRequest(ORIGIN + target + (options.query ?? ''), {
    method,
    headers,
    ...(method === 'POST' ? { body: options.rawBody ?? JSON.stringify(options.body ?? {}) } : {}),
  });
  return Promise.resolve(
    options.peer === false ? handler(req) : fj.localPeer.withLocalPeerRequest(req, handler)
  );
}

export type Body = Record<string, any>;
export async function call(response: Promise<Response>) {
  const resolved = await response;
  return {
    status: resolved.status,
    headers: resolved.headers,
    body: (await resolved.json()) as Body,
  };
}
const params = (requestId: string) => ({ params: Promise.resolve({ requestId }) });
export const read = (query = '', options: Options = {}) =>
  call(send('GET', '/api/first-job' + query, options, (req) => fj.main.GET(req)));
export const start = (body: Body, options: Options = {}) =>
  call(send('POST', '/api/first-job', { ...options, body }, (req) => fj.main.POST(req)));
export const readApprovals = (sessionId: string, options: Options = {}) =>
  call(
    send('GET', '/api/first-job/approvals?session_id=' + sessionId, options, (req) =>
      fj.approvalList.GET(req)
    )
  );
export const readArtifact = (query: string, options: Options = {}) =>
  call(send('GET', '/api/first-job/artifact?' + query, options, (req) => fj.artifact.GET(req)));
export const decide = (approvalId: string, body: Body, options: Options = {}) =>
  call(
    send('POST', `/api/first-job/approvals/${approvalId}/decision`, { ...options, body }, (req) =>
      fj.decision.POST(req, params(approvalId))
    )
  );
export const terminate = (requestId: string, body: Body, options: Options = {}) =>
  call(
    send('POST', `/api/first-job/recovery/${requestId}`, { ...options, body }, (req) =>
      fj.recovery.POST(req, params(requestId))
    )
  );

export async function sessionId(): Promise<string> {
  const { status, body } = await read();
  expect(status).toBe(200);
  expect(body.readiness).toEqual({ ready: true, status: 'diagnostic_mapping_ready' });
  return body.sessionId as string;
}

/** Send the fixed first request and run one operator tick: it waits for the owner's approval. */
export async function heldRequest() {
  const session = await sessionId();
  const requestId = randomUUID();
  const started = await start({ action: 'start', request_id: requestId, session_id: session });
  expect(started.status).toBe(200);
  expect(started.body).toMatchObject({ ok: true, request_id: requestId, mode: 'intake' });
  const tick = await standalone(() => fj.operator.tickFirstJob(tenant));
  expect(tick.outcome).toBe('awaiting_approval');
  const listed = await readApprovals(session);
  expect(listed.status).toBe(200);
  expect(listed.body.auth.status).toBe('ready');
  const card = listed.body.approvals.find((row: Body) => row.request_id === requestId);
  expect(card).toBeTruthy();
  return { session, requestId, card: card as Body };
}
