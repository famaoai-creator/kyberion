/**
 * Shared harness for the Concierge hearing and conversation route tests
 * (`src/app/api/hearing/**`, `src/app/api/conversation`, `src/app/api/ask-vocabulary`).
 * Hermetic: a temporary KYBERION_ROOT (product policy and schemas copied in,
 * as `test/first-job-route-harness.ts` does) under SYSTEM_ROLE=concierge, so
 * the role assumption policy and the path authority of the hearing, ledger
 * and work-inventory stores are the real ones. The local-peer proof, the
 * Concierge viewer (a real signed browser session) and installation-owner
 * access are real too; nothing synthesizes a loopback viewer.
 *
 * Module caches pin the root a file first loaded, so each test file sets up
 * its own root in `beforeAll` and removes it in `afterAll`.
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { vi } from 'vitest';
import { NextRequest } from 'next/server';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const HEARING_TENANT = 'hearing-route';
export const OTHER_TENANT = 'hearing-other';
export const HOST = '127.0.0.1:3050';
export const ORIGIN = 'http://' + HOST;
export const MEMBER_SUBJECT = 'hearing-member-subject';

interface Fixture {
  FIRST_JOB_TEST_ISSUER: string;
  FIRST_JOB_TEST_SUBJECT: string;
  FIRST_JOB_TEST_SESSION_KEY: string;
  seedFirstJobTestRoot(sourceRoot: string, root: string): void;
  syntheticFirstJobOwner(tenant: string): Record<string, unknown>;
}

type RouteModule = Record<string, (req: NextRequest, context?: unknown) => Promise<Response>>;

/** The loaded modules and the current credentials of one installation. */
export const hr = {
  root: path.join(sourceRoot, 'active/shared/tmp', `vitest-hearing-${randomUUID()}`),
  fixture: undefined as unknown as Fixture,
  io: undefined as unknown as typeof import('@agent/core'),
  authority: undefined as unknown as typeof import('@agent/core/authority'),
  browser: undefined as unknown as typeof import('@agent/core/authn/authn-providers'),
  owner: undefined as unknown as typeof import('@agent/core/surface/installation-owner-access'),
  runtime: undefined as unknown as typeof import('@agent/core/surface/hearing-runtime'),
  localPeer: undefined as unknown as typeof import('../server/local-peer.ts'),
  routes: {} as Record<string, RouteModule>,
  ownerToken: '',
  memberToken: '',
};

const ROUTES: Record<string, string> = {
  record: '../src/app/api/hearing/[session]/route',
  canvas: '../src/app/api/hearing/[session]/canvas/route',
  answer: '../src/app/api/hearing/[session]/answer/route',
  decide: '../src/app/api/hearing/[session]/decide/route',
  receipt: '../src/app/api/hearing/[session]/decision-receipts/[operation]/route',
  inventory: '../src/app/api/hearing/[session]/inventory/route',
  handoff: '../src/app/api/hearing/[session]/handoff/route',
  recordDecisions: '../src/app/api/hearing/[session]/record-decisions/route',
  agenda: '../src/app/api/hearing/decisions/agenda/route',
  conversation: '../src/app/api/conversation/route',
  vocabulary: '../src/app/api/ask-vocabulary/route',
  message: '../src/app/api/message/route',
};

export function mint(subject: string): string {
  return hr.browser.mintBrowserSessionToken({
    idpIssuer: hr.fixture.FIRST_JOB_TEST_ISSUER,
    subject,
    ttlSeconds: 1800,
  }).token;
}

/**
 * One installation: the root seeded and the routes loaded. `ownerTenants`
 * are the installation owner's memberships (none: the owner's viewer has no
 * single tenant, so it reaches the personal hearing store).
 */
export async function setUpHearing(
  options: { ownerTenants?: string[]; memberTenants?: string[] } = {}
): Promise<void> {
  const bootstrap = await import('@agent/core');
  hr.fixture = (await import(
    /* @vite-ignore */ path.join(sourceRoot, 'scripts/fixtures/first-job-approval-fixture.ts')
  )) as Fixture;
  hr.fixture.seedFirstJobTestRoot(sourceRoot, hr.root);
  bootstrap.safeMkdir(path.join(hr.root, 'knowledge/public/common'), { recursive: true });
  bootstrap.safeCopyFileSync(
    path.join(sourceRoot, 'knowledge/public/common/project_standards.json'),
    path.join(hr.root, 'knowledge/public/common/project_standards.json')
  );
  vi.stubEnv('KYBERION_ROOT', hr.root);
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
  vi.stubEnv('KYBERION_SESSION_SECRET', hr.fixture.FIRST_JOB_TEST_SESSION_KEY);
  vi.stubEnv('KYBERION_OIDC_ISSUER', hr.fixture.FIRST_JOB_TEST_ISSUER);
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
  vi.resetModules();
  hr.io = await import('@agent/core');
  hr.authority = await import('@agent/core/authority');
  hr.browser = await import('@agent/core/authn/authn-providers');
  hr.owner = await import('@agent/core/surface/installation-owner-access');
  hr.runtime = await import('@agent/core/surface/hearing-runtime');
  hr.localPeer = await import('../server/local-peer.ts');
  for (const [name, relative] of Object.entries(ROUTES))
    hr.routes[name] = (await import(/* @vite-ignore */ relative)) as RouteModule;
  await bindMembers(options);
}

/** The installation owner and a second member who is not the owner of this machine. */
async function bindMembers(options: {
  ownerTenants?: string[];
  memberTenants?: string[];
}): Promise<void> {
  const { fixture } = hr;
  const members = await import('@agent/core/organization/member-registry');
  const tenants = await import('@agent/core/organization/tenant-registry');
  // Registered tenants, as on a real installation (the dock's conversation
  // viewer validates a selected tenant against the registry).
  for (const tenant of [HEARING_TENANT, OTHER_TENANT])
    hr.authority.withExecutionContext('sovereign_concierge', () =>
      tenants.writeTenantProfile({
        tenant_slug: tenant,
        display_name: 'Synthetic hearing tenant ' + tenant,
        status: 'active',
        assigned_role: 'owner',
      } as Parameters<typeof tenants.writeTenantProfile>[0])
    );
  const ownerTenants = options.ownerTenants ?? [HEARING_TENANT];
  const memberTenants = options.memberTenants ?? [HEARING_TENANT];
  const base = fixture.syntheticFirstJobOwner(HEARING_TENANT);
  const memberships = (tenants: string[]) =>
    tenants.map((tenant) => ({ tenant_slug: tenant, role: 'owner' as const }));
  hr.authority.withExecutionContext('sovereign_concierge', () => {
    for (const profile of [
      { ...base, memberships: memberships(ownerTenants) },
      {
        ...base,
        member_id: 'member',
        display_name: 'Second member',
        memberships: memberships(memberTenants),
        external_identities: [{ issuer: fixture.FIRST_JOB_TEST_ISSUER, subject: MEMBER_SUBJECT }],
      },
    ])
      members.writeMemberProfile(profile as Parameters<typeof members.writeMemberProfile>[0]);
  });
  hr.owner.resetInstallationBootstrapCache();
  hr.ownerToken = mint(fixture.FIRST_JOB_TEST_SUBJECT);
  hr.memberToken = mint(MEMBER_SUBJECT);
}

export async function tearDownHearing(): Promise<void> {
  vi.unstubAllEnvs();
  vi.resetModules();
  const bootstrap = await import('@agent/core');
  bootstrap.safeRmSync(hr.root, { recursive: true, force: true });
}

export interface Options {
  /** The local server's attested loopback peer; `false` = a remote request. */
  peer?: boolean;
  host?: string;
  /** `undefined`: the local origin on POST, none on GET; `null`: no Origin header. */
  origin?: string | null;
  /** `undefined`: the owner's session; `null`: no credential. */
  token?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sent verbatim instead of `JSON.stringify(body)`. */
  rawBody?: string;
}

/**
 * The local server's socket-to-NextRequest admission seam (as
 * `test/local-peer-fixture.ts`), held until the async handler has answered:
 * the server keeps the proof until the response finishes.
 */
async function withAttestedPeer(
  request: NextRequest,
  run: (req: NextRequest) => Promise<Response>
): Promise<Response> {
  const url = new URL(request.url);
  const raw = {
    method: request.method,
    url: url.pathname + url.search,
    socket: { remoteAddress: '127.0.0.1' },
    headers: Object.fromEntries(request.headers),
    rawHeaders: [],
  } as unknown as IncomingMessage;
  const response = new EventEmitter() as ServerResponse;
  hr.localPeer.attestLocalPeer(raw, response);
  const verified = new NextRequest(request, { headers: raw.headers as Record<string, string> });
  try {
    return await run(verified);
  } finally {
    response.emit('finish');
  }
}

/** Call one route as the local Concierge server hands it to Next. */
export async function call(
  route: keyof typeof ROUTES,
  method: 'GET' | 'POST',
  target: string,
  params: Record<string, string> = {},
  options: Options = {}
): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }> {
  const headers: Record<string, string> = { host: options.host ?? HOST };
  const origin =
    options.origin === undefined ? (method === 'POST' ? ORIGIN : null) : options.origin;
  if (origin) headers.origin = origin;
  const token = options.token === undefined ? hr.ownerToken : options.token;
  if (token) headers.cookie = 'kyberion_session=' + token;
  if (method === 'POST') headers['content-type'] = 'application/json';
  Object.assign(headers, options.headers);
  const req = new NextRequest(ORIGIN + target, {
    method,
    headers,
    ...(method === 'POST'
      ? {
          body: options.rawBody ?? (options.body === undefined ? '' : JSON.stringify(options.body)),
        }
      : {}),
  });
  const handler = hr.routes[route][method];
  const context = { params: Promise.resolve(params) };
  const response = await (options.peer === false
    ? handler(req, context)
    : withAttestedPeer(req, (verified) => handler(verified, context)));
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // HTML (the canvas) or an empty body.
  }
  return { status: response.status, body, text, headers: response.headers };
}

/** A stored hearing record, read as the hearing storage reads it (elevated, tenant-bound). */
export function storedHearing(namespace: string, id: string) {
  return hr.authority.withExecutionContext(
    'ecosystem_architect',
    () => hr.runtime.loadHearingRecord(namespace, id),
    undefined,
    namespace === 'all' || namespace === 'unscoped' ? undefined : namespace
  );
}

/** A fresh, valid hearing session id. */
export function sessionId(): string {
  return 'hearing-' + randomUUID();
}
