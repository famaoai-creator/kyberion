import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withLocalPeerRequest } from '../../../../../test/local-peer-fixture';

const fixture = vi.hoisted(() => ({ root: '', audit: [] as Array<Record<string, unknown>> }));

vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));

// The real provisioning logic, pointed at a temp root with a captured audit sink.
function withFixture<M extends Record<string, unknown>>(original: M, names: string[]): M {
  const wrapped: Record<string, unknown> = { ...original };
  for (const name of names) {
    const fn = original[name] as (...args: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      const padded = [...args];
      while (padded.length < fn.length - 1) padded.push(undefined);
      return fn(...padded, {
        rootDir: fixture.root,
        audit: (event: Record<string, unknown>) => fixture.audit.push(event),
      });
    };
  }
  return wrapped as M;
}
vi.mock('@agent/core/organization/scim-token-registry', async (importOriginal) =>
  withFixture(await importOriginal<Record<string, unknown>>(), ['authenticateScimToken'])
);
vi.mock('@agent/core/organization/scim-users', async (importOriginal) =>
  withFixture(await importOriginal<Record<string, unknown>>(), [
    'listScimUsers',
    'getScimUser',
    'createScimUser',
    'replaceScimUser',
    'patchScimUser',
    'deactivateScimUser',
  ])
);

import * as pathResolver from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { writeMemberProfile, readMemberProfile } from '@agent/core/organization/member-registry';
import { writeTenantProfile } from '@agent/core/organization/tenant-registry';
import {
  issueScimToken,
  resetScimRejectAuditThrottle,
} from '@agent/core/organization/scim-token-registry';
import {
  SCIM_ERROR_SCHEMA,
  SCIM_LIST_RESPONSE_SCHEMA,
  SCIM_PATCH_OP_SCHEMA,
  SCIM_USER_SCHEMA,
} from '@agent/core/organization/scim-protocol';
import { GET as listUsers, POST as createUser } from './route';
import { DELETE, GET as getUser, PATCH, PUT } from './[id]/route';
import { GET as serviceProviderConfig } from '../ServiceProviderConfig/route';
import { GET as resourceTypes } from '../ResourceTypes/route';
import { GET as schemas } from '../Schemas/route';
import { resolveConciergeViewerContext } from '../../../../lib/viewer-context';
import { SCIM_RATE_LIMIT_PER_MINUTE } from '../../../../lib/scim-server';

const ISSUER = 'https://idp.example.com';
const ORIGIN = 'https://concierge.example.com';
const NOW = '2026-10-10T09:00:00.000Z';

function request(
  pathname: string,
  init: {
    method?: string;
    token?: string | null;
    body?: unknown;
    contentType?: string;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined)
    headers['content-type'] = init.contentType ?? 'application/scim+json';
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined
      ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }
      : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function expectScimError(response: Response, status: number, scimType?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toMatch(/^application\/scim\+json/);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.schemas).toEqual([SCIM_ERROR_SCHEMA]);
  expect(body.status).toBe(String(status));
  expect(typeof body.detail).toBe('string');
  if (scimType) expect(body.scimType).toBe(scimType);
  return body;
}

describe('/scim/v2 routes', () => {
  let acmeToken = '';
  let betaToken = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  beforeAll(() => {
    fixture.root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `scim-route-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    const opts = { rootDir: fixture.root, audit: () => undefined };
    vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URL', '');
    vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URLS', '');
    for (const slug of ['acme', 'beta']) {
      writeTenantProfile(
        { tenant_slug: slug, display_name: slug, status: 'active', assigned_role: 'owner' },
        opts
      );
    }
    writeMemberProfile(
      {
        member_id: 'owner',
        display_name: 'Owner',
        status: 'active',
        memberships: [
          { tenant_slug: 'acme', role: 'owner' },
          { tenant_slug: 'beta', role: 'owner' },
        ],
        access_registrations: [],
        created_at: NOW,
        updated_at: NOW,
      },
      opts
    );
    const issue = (tenantSlug: string) =>
      issueScimToken({ tenantSlug, label: 'IdP', issuer: ISSUER, issuedByMemberId: 'owner' }, opts)
        .token;
    acmeToken = issue('acme');
    betaToken = issue('beta');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (fixture.root) safeRmSync(fixture.root, { recursive: true, force: true });
  });

  it('401s without a SCIM token — no loopback, cookie, member or localadmin path', async () => {
    const missing = await expectScimError(await listUsers(request('/scim/v2/Users')), 401);
    expect(missing.detail).toMatch(/SCIM provisioning token/);

    const loopback = await withLocalPeerRequest(request('/scim/v2/Users'), (req) => listUsers(req));
    await expectScimError(loopback, 401);
    expect(loopback.headers.get('www-authenticate')).toMatch(/^Bearer/);

    vi.stubEnv('KYBERION_LOCALADMIN_TOKEN', 'localadmin-secret-token');
    await expectScimError(
      await listUsers(request('/scim/v2/Users', { token: 'localadmin-secret-token' })),
      401
    );
    await expectScimError(
      await listUsers(request('/scim/v2/Users', { token: 'a'.repeat(64) })),
      401
    );
    await expectScimError(
      await listUsers(
        request('/scim/v2/Users', { headers: { cookie: `kyberion_session=${acmeToken}` } })
      ),
      401
    );
    await expectScimError(
      await serviceProviderConfig(request('/scim/v2/ServiceProviderConfig')),
      401
    );
  });

  it('a SCIM token is refused by the other Concierge APIs', () => {
    expect(() => resolveConciergeViewerContext(request('/api/me', { token: acmeToken }))).toThrow(
      /Unknown Concierge viewer token/
    );
  });

  it('serves discovery documents as application/scim+json', async () => {
    const config = await serviceProviderConfig(
      request('/scim/v2/ServiceProviderConfig', { token: acmeToken })
    );
    expect(config.status).toBe(200);
    expect(config.headers.get('content-type')).toMatch(/^application\/scim\+json/);
    expect(await config.json()).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
    });
    const types = await (
      await resourceTypes(request('/scim/v2/ResourceTypes', { token: acmeToken }))
    ).json();
    expect(types).toMatchObject({
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      Resources: [{ id: 'User' }],
    });
    const schemaList = await (
      await schemas(request('/scim/v2/Schemas', { token: acmeToken }))
    ).json();
    expect(schemaList.Resources[0].id).toBe(SCIM_USER_SCHEMA);
  });

  it('creates (201 + Location), reads, filters, patches and deactivates (204)', async () => {
    const created = await createUser(
      request('/scim/v2/Users', {
        method: 'POST',
        token: acmeToken,
        body: { schemas: [SCIM_USER_SCHEMA], userName: 'ann@acme.test', externalId: 'oid-ann' },
      })
    );
    expect(created.status).toBe(201);
    expect(created.headers.get('content-type')).toMatch(/^application\/scim\+json/);
    const user = (await created.json()) as { id: string; meta: { location: string } };
    expect(created.headers.get('location')).toBe(`${ORIGIN}/scim/v2/Users/${user.id}`);
    expect(user.meta.location).toBe(`${ORIGIN}/scim/v2/Users/${user.id}`);
    expect(
      fixture.audit.some((e) => e.action === 'scim.user.create' && e.memberId === user.id)
    ).toBe(true);

    const found = await listUsers(
      request(`/scim/v2/Users?filter=${encodeURIComponent('userName eq "ann@acme.test"')}`, {
        token: acmeToken,
      })
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ totalResults: 1, Resources: [{ id: user.id }] });

    const fetched = await getUser(
      request(`/scim/v2/Users/${user.id}`, { token: acmeToken }),
      params(user.id)
    );
    expect(fetched.status).toBe(200);

    const replaced = await PUT(
      request(`/scim/v2/Users/${user.id}`, {
        method: 'PUT',
        token: acmeToken,
        contentType: 'application/json',
        body: {
          schemas: [SCIM_USER_SCHEMA],
          userName: 'ann@acme.test',
          externalId: 'oid-ann',
          displayName: 'Ann',
        },
      }),
      params(user.id)
    );
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as { displayName: string }).displayName).toBe('Ann');

    const patched = await PATCH(
      request(`/scim/v2/Users/${user.id}`, {
        method: 'PATCH',
        token: acmeToken,
        body: {
          schemas: [SCIM_PATCH_OP_SCHEMA],
          Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
        },
      }),
      params(user.id)
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { active: boolean }).active).toBe(false);

    const removed = await DELETE(
      request(`/scim/v2/Users/${user.id}`, { method: 'DELETE', token: acmeToken }),
      params(user.id)
    );
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect(readMemberProfile(user.id, { rootDir: fixture.root })?.status).toBe('suspended');
  });

  it('locates resources under the declared public origin, not the Host header', async () => {
    vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URLS', 'concierge=https://desk.example.test');
    try {
      const created = await createUser(
        request('/scim/v2/Users', {
          method: 'POST',
          token: acmeToken,
          body: { schemas: [SCIM_USER_SCHEMA], userName: 'loc@acme.test' },
        })
      );
      expect(created.status).toBe(201);
      const user = (await created.json()) as { id: string; meta: { location: string } };
      expect(created.headers.get('location')).toBe(
        `https://desk.example.test/scim/v2/Users/${user.id}`
      );
      expect(user.meta.location).toBe(`https://desk.example.test/scim/v2/Users/${user.id}`);
    } finally {
      vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URLS', '');
    }
  });

  it("tenant B's token gets 404 for tenant A's user and cannot change it", async () => {
    const created = await createUser(
      request('/scim/v2/Users', {
        method: 'POST',
        token: acmeToken,
        body: { schemas: [SCIM_USER_SCHEMA], userName: 'iso@acme.test' },
      })
    );
    const { id } = (await created.json()) as { id: string };
    await expectScimError(
      await getUser(request(`/scim/v2/Users/${id}`, { token: betaToken }), params(id)),
      404
    );
    await expectScimError(
      await DELETE(
        request(`/scim/v2/Users/${id}`, { method: 'DELETE', token: betaToken }),
        params(id)
      ),
      404
    );
    expect(readMemberProfile(id, { rootDir: fixture.root })?.status).toBe('active');
    const listed = await (await listUsers(request('/scim/v2/Users', { token: betaToken }))).json();
    expect(
      (listed as { Resources: Array<{ id: string }> }).Resources.map((u) => u.id)
    ).not.toContain(id);
  });

  it('maps protocol failures onto the SCIM error schema', async () => {
    await expectScimError(
      await listUsers(
        request(`/scim/v2/Users?filter=${encodeURIComponent('userName co "a"')}`, {
          token: acmeToken,
        })
      ),
      400,
      'invalidFilter'
    );
    await expectScimError(
      await createUser(
        request('/scim/v2/Users', { method: 'POST', token: acmeToken, body: '{not json' })
      ),
      400,
      'invalidSyntax'
    );
    await expectScimError(
      await createUser(
        request('/scim/v2/Users', {
          method: 'POST',
          token: acmeToken,
          body: { userName: 'x' },
          contentType: 'text/plain',
        })
      ),
      415
    );
    await expectScimError(
      await createUser(
        request('/scim/v2/Users', {
          method: 'POST',
          token: acmeToken,
          body: { schemas: [SCIM_USER_SCHEMA], userName: 'ann@acme.test' },
        })
      ),
      409,
      'uniqueness'
    );
    await expectScimError(
      await PATCH(
        request('/scim/v2/Users/owner', {
          method: 'PATCH',
          token: acmeToken,
          body: {
            schemas: [SCIM_PATCH_OP_SCHEMA],
            Operations: [{ op: 'replace', path: 'roles', value: 'owner' }],
          },
        }),
        params('owner')
      ),
      400,
      'invalidPath'
    );
  });

  it('rate limits by client address, so rotating tokens does not reset it (429 + Retry-After)', async () => {
    vi.stubEnv('KYBERION_TRUST_PROXY', 'true');
    resetScimRejectAuditThrottle();
    const rejectsBefore = fixture.audit.filter((e) => e.action === 'scim.token.reject').length;
    const fromAttacker = (token: string) =>
      request('/scim/v2/ServiceProviderConfig', {
        token,
        headers: { 'x-real-ip': '203.0.113.7' },
      });
    const rotated = () =>
      `kscim~acme~scim-${randomUUID().replace(/-/g, '').slice(0, 16)}~${randomUUID()}${randomUUID()}`;
    for (let i = 0; i < SCIM_RATE_LIMIT_PER_MINUTE; i += 1) {
      expect((await serviceProviderConfig(fromAttacker(rotated()))).status).toBe(401);
    }
    const limited = await serviceProviderConfig(fromAttacker(rotated()));
    await expectScimError(limited, 429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Even the tenant's real token is throttled from that address...
    await expectScimError(await serviceProviderConfig(fromAttacker(acmeToken)), 429);
    // ...while the IdP calling from elsewhere is unaffected.
    const fromIdp = await serviceProviderConfig(
      request('/scim/v2/ServiceProviderConfig', {
        token: acmeToken,
        headers: { 'x-real-ip': '198.51.100.20' },
      })
    );
    expect(fromIdp.status).toBe(200);
    // The rotation produced one coalesced reject entry, not hundreds.
    const rejects = fixture.audit.filter((e) => e.action === 'scim.token.reject').length;
    expect(rejects - rejectsBefore).toBe(1);
  });

  it('refuses oversized bodies before buffering them (413), with or without Content-Length', async () => {
    const oversized = JSON.stringify({
      schemas: [SCIM_USER_SCHEMA],
      userName: 'big@acme.test',
      displayName: 'x'.repeat(70 * 1024),
    });
    const declared = await createUser(
      request('/scim/v2/Users', {
        method: 'POST',
        token: acmeToken,
        body: oversized,
        headers: { 'content-length': String(Buffer.byteLength(oversized)) },
      })
    );
    await expectScimError(declared, 413);

    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const chunked = new NextRequest(`${ORIGIN}/scim/v2/Users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${acmeToken}`, 'content-type': 'application/scim+json' },
      body: stream,
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: 'half' });
    expect(chunked.headers.get('content-length')).toBeNull();
    await expectScimError(await createUser(chunked), 413);
    // Reading stopped just past the 64 KiB cap instead of draining 1 MiB.
    expect(pulled).toBeLessThan(10);
  });
});
