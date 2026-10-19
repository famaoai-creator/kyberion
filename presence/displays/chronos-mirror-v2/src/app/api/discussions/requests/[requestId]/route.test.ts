import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
const id = 'aedc5d82-e246-4db8-af14-84b1e4a2f278';
const scopeDigest = createHash('sha256')
  .update(JSON.stringify(['acme', 'org-a', 'PRJ-A', 'MSN-A', 'confidential']))
  .digest('hex');
const m = vi.hoisted(() => ({
  recover: vi.fn(),
  guard: vi.fn(() => null),
  access: vi.fn(() => null),
  viewer: {
    role: 'localadmin',
    source: 'token',
    principalId: 'fixture-human',
    tenantSlugs: ['acme'],
  } as Record<string, unknown>,
  scope: vi.fn(() => ({
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'PRJ-A',
    mission_id: 'MSN-A',
  })),
  context: vi.fn((_viewer, fn) => fn()),
}));
vi.mock('@agent/core/discussion/discussion-create-request', () => ({
  recoverDiscussionRequest: m.recover,
}));
vi.mock('../../../../../lib/api-guard', () => ({
  guardRequest: m.guard,
  requireChronosAccess: m.access,
}));
vi.mock('../../../../../lib/discussion-request-scope', () => ({
  resolveDiscussionRequestScope: m.scope,
  DiscussionMissionScopeError: class extends Error {},
}));
vi.mock('../../../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: () => ({ context: m.viewer }),
  ViewerContextError: class extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
  withViewerExecutionContext: m.context,
}));
import { GET } from './route';
const req = () =>
  ({
    nextUrl: new URL(
      'https://fixture.test/api/discussions/requests/' +
        id +
        '?mission_id=MSN-A&tenant=acme&goal=must-not-be-used&actor=attacker&scope_digest=' +
        scopeDigest
    ),
  }) as NextRequest;
beforeEach(() => {
  vi.clearAllMocks();
  m.viewer.source = 'token';
  m.viewer.principalId = 'fixture-human';
  m.scope.mockReturnValue({
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'PRJ-A',
    mission_id: 'MSN-A',
  });
  m.recover.mockReturnValue({
    request: { request_id: id, status: 'unconfirmed' },
    should_start: false,
  });
});
it('reconciles only the authenticated actor and freshly canonical original routing scope', async () => {
  const response = await GET(req(), { params: Promise.resolve({ requestId: id }) });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(m.scope).toHaveBeenCalledWith(m.viewer, {
    mission_id: 'MSN-A',
    tenant: 'acme',
    organization_id: null,
    project_id: null,
  });
  expect(m.recover).toHaveBeenCalledWith({
    request_id: id,
    actor: { principal_id: 'fixture-human', source: 'token' },
    scope: {
      tenant_slug: 'acme',
      organization_id: 'org-a',
      project_id: 'PRJ-A',
      mission_id: 'MSN-A',
      tier: 'confidential',
    },
  });
  expect((await response.json()).request.status).toBe('unconfirmed');
});
it('does not look up a receipt after current scope authorization fails', async () => {
  m.scope.mockImplementationOnce(() => {
    throw new Error('private scope/path detail');
  });
  const response = await GET(req(), { params: Promise.resolve({ requestId: id }) });
  expect(m.recover).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain('private scope/path detail');
});
it.each(['anonymous', undefined])(
  'requires an authenticated immutable source (%s)',
  async (source) => {
    m.viewer.source = source;
    expect((await GET(req(), { params: Promise.resolve({ requestId: id }) })).status).toBe(403);
    expect(m.recover).not.toHaveBeenCalled();
  }
);
it('does not substitute a role when the principal is missing', async () => {
  delete m.viewer.principalId;
  expect((await GET(req(), { params: Promise.resolve({ requestId: id }) })).status).toBe(403);
  expect(m.recover).not.toHaveBeenCalled();
});
it('returns exact positive created evidence without any execution action', async () => {
  m.recover.mockReturnValue({
    request: { request_id: id, status: 'created', room_id: 'disc-bound' },
    room: { id: 'disc-bound' },
    should_start: false,
  });
  const response = await GET(req(), { params: Promise.resolve({ requestId: id }) });
  expect(await response.json()).toEqual({
    ok: true,
    request: { request_id: id, status: 'created', room_id: 'disc-bound' },
    room: { id: 'disc-bound' },
  });
});
it('blocks missing selected tenant before receipt I/O', async () => {
  m.scope.mockReturnValueOnce({} as never);
  expect((await GET(req(), { params: Promise.resolve({ requestId: id }) })).status).toBe(403);
  expect(m.recover).not.toHaveBeenCalled();
});

import { GET as contextGET } from '../../request-context/route';
it('resolves canonical routing before submission without receipt or provider work', async () => {
  const response = contextGET(req());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    routing: {
      scope_digest: scopeDigest,
      tenant: 'acme',
      organization_id: 'org-a',
      project_id: 'PRJ-A',
      mission_id: 'MSN-A',
    },
  });
  expect(m.recover).not.toHaveBeenCalled();
});
it('reports missing tenant during read-only context inspection before any reservation', async () => {
  m.scope.mockReturnValueOnce({} as never);
  const response = contextGET(req());
  expect(response.status).toBe(403);
  expect((await response.json()).error).toContain('nothing was submitted');
  expect(m.recover).not.toHaveBeenCalled();
});

it('does not read an old request through a changed canonical mission scope', async () => {
  m.scope.mockReturnValueOnce({
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'PRJ-NEW',
    mission_id: 'MSN-A',
  });
  expect((await GET(req(), { params: Promise.resolve({ requestId: id }) })).status).toBe(403);
  expect(m.recover).not.toHaveBeenCalled();
});
