import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  guard: vi.fn(),
  access: vi.fn(),
  viewer: vi.fn(),
  inspect: vi.fn(),
  tier: vi.fn(),
  tenants: vi.fn(),
  organizations: vi.fn(),
  projects: vi.fn(),
  missions: vi.fn(),
}));
vi.mock('@agent/core/discussion/discussion-engine', () => ({ ensureDiscussionRunning: mocks.run }));
vi.mock('@agent/core/discussion/discussion-store', () => ({
  createDiscussionRoom: mocks.create,
  readDiscussionRoom: () => null,
  listDiscussionRooms: () => [],
  DiscussionUserError: class extends Error {},
}));
vi.mock('@agent/core/discussion/discussion-readiness', () => ({
  inspectDiscussionReadiness: mocks.inspect,
}));
vi.mock('../../../../lib/api-guard', () => ({
  guardRequest: mocks.guard,
  requireChronosAccess: mocks.access,
}));
vi.mock('../../../../lib/su-surface-data', () => ({ buildMissionHistoryItems: mocks.missions }));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.viewer,
  viewerErrorResponse: (_error: unknown, status = 403) =>
    Response.json({ error: 'scope denied' }, { status }),
  strictViewerTier: mocks.tier,
  strictViewerScopeTenantSlugs: mocks.tenants,
  strictViewerScopeOrganizationIds: mocks.organizations,
  strictViewerScopeProjectIds: mocks.projects,
  withViewerExecutionContext: (_viewer: unknown, fn: () => unknown) => fn(),
  ViewerContextError: class extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
}));
import { GET } from './route';
import { POST } from '../route';
import { ViewerContextError } from '../../../../lib/viewer-context';
const request = (query = 'provider=codex') =>
  new NextRequest('http://localhost/api/discussions/readiness?' + query);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockImplementation((input) => ({ id: 'fixture-room', ...input }));
  mocks.run.mockResolvedValue(undefined);
  mocks.viewer.mockReturnValue({ context: { role: 'localadmin', principalId: 'fixture-viewer' } });
  mocks.tenants.mockReturnValue(['fixture']);
  mocks.organizations.mockReturnValue('all');
  mocks.projects.mockReturnValue('all');
  mocks.missions.mockReturnValue([]);
  mocks.inspect.mockImplementation((provider) => ({
    provider,
    checked_at: '2026-10-18T00:00:00.000Z',
    provider_calls: 0,
    execution: 'unverified',
    checks: [],
  }));
});
describe('Discussion readiness request boundary (no provider calls)', () => {
  it('requires the same create access and reports only static prerequisites without accepting goal text', async () => {
    const response = GET(request('provider=codex&goal=do-not-transmit&tier=public'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 'localadmin');
    expect(mocks.tier).toHaveBeenCalledWith(expect.anything(), 'confidential');
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith('codex', { tenant_slug: 'fixture' });
    expect(await response.json()).toMatchObject({
      readiness: { execution: 'unverified', provider_calls: 0 },
    });
  });
  it.each(['stub', 'auto', 'other', ''])(
    'rejects unsupported provider %s before inspection',
    (provider) => {
      expect(GET(request('provider=' + provider)).status).toBe(400);
      expect(mocks.inspect).not.toHaveBeenCalled();
    }
  );
  it.each(['guard', 'access', 'viewer'])('does no inspection after %s denial', (stage) => {
    const response = Response.json({ error: 'denied' }, { status: 403 });
    if (stage === 'viewer') mocks.viewer.mockReturnValue({ response });
    else mocks[stage].mockReturnValue(response);
    expect(GET(request()).status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it('rejects unavailable confidential tier without leaking policy details', async () => {
    mocks.tier.mockImplementation(() => {
      throw new ViewerContextError(403, 'private policy details');
    });
    const response = GET(request());
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('private');
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it('rejects attempted cross-tenant narrowing', () => {
    mocks.tenants.mockImplementation((_viewer, requested) => {
      if (requested === 'other') throw new ViewerContextError(403, 'denied');
      return ['fixture'];
    });
    expect(GET(request('provider=codex&tenant=other')).status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it('requires one selected tenant and never picks an arbitrary allowed tenant', () => {
    mocks.tenants.mockReturnValue(['one', 'two']);
    expect(GET(request()).status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it.each(['public', 'personal', 'missing'])(
    'does not link a %s mission or downgrade its content tier',
    (tier) => {
      mocks.missions.mockReturnValue(
        tier === 'missing' ? [] : [{ missionId: 'MSN-FIXTURE', tier, tenantSlug: 'fixture' }]
      );
      expect(GET(request('provider=codex&mission_id=MSN-FIXTURE&tier=public')).status).toBe(404);
      expect(mocks.inspect).not.toHaveBeenCalled();
    }
  );
  it('uses exactly the visible confidential mission scope in both inspection and creation helper', () => {
    mocks.missions.mockReturnValue([
      {
        missionId: 'MSN-FIXTURE',
        tier: 'confidential',
        tenantSlug: 'fixture',
        projectId: 'fixture-project',
      },
    ]);
    expect(GET(request('provider=claude&mission_id=msn-fixture')).status).toBe(200);
    expect(mocks.missions).toHaveBeenCalledWith({
      missionId: 'msn-fixture',
      tier: 'confidential',
      tenantSlugs: ['fixture'],
      organizationIds: 'all',
      projectIds: 'all',
      limit: 1,
    });
    expect(mocks.inspect).toHaveBeenCalledWith('claude', {
      tenant_slug: 'fixture',
      project_id: 'fixture-project',
      mission_id: 'MSN-FIXTURE',
      tier: 'confidential',
    });
  });
  it('reports configured blockers as inspection results, never as permission to execute', async () => {
    mocks.inspect.mockReturnValue({
      provider: 'codex',
      execution: 'unverified',
      provider_calls: 0,
      checks: [{ id: 'egress_policy', status: 'blocked', code: 'egress_denied' }],
    });
    const response = GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).readiness.checks[0].status).toBe('blocked');
  });
  it('masks unexpected inspection failures and does not manufacture a ready report', async () => {
    mocks.inspect.mockImplementation(() => {
      throw new Error('secret /private/path');
    });
    const response = GET(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).not.toHaveProperty('readiness');
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

it.each(['organization', 'project'])(
  'rejects a same-tenant mission outside viewer %s scope before inspection',
  (kind) => {
    mocks.missions.mockReturnValue([
      {
        missionId: 'MSN-FIXTURE',
        tier: 'confidential',
        tenantSlug: 'fixture',
        organizationId: 'foreign-org',
        projectId: 'foreign-project',
      },
    ]);
    if (kind === 'organization') mocks.organizations.mockReturnValue(['allowed-org']);
    else mocks.projects.mockReturnValue(['allowed-project']);
    expect(GET(request('provider=codex&mission_id=MSN-FIXTURE')).status).toBe(404);
    expect(mocks.inspect).not.toHaveBeenCalled();
  }
);
it('stamps a linked mission organization rather than relabeling it from the client', () => {
  mocks.missions.mockReturnValue([
    {
      missionId: 'MSN-FIXTURE',
      tier: 'confidential',
      tenantSlug: 'fixture',
      organizationId: 'mission-org',
    },
  ]);
  expect(GET(request('provider=codex&mission_id=MSN-FIXTURE')).status).toBe(200);
  expect(mocks.inspect).toHaveBeenCalledWith(
    'codex',
    expect.objectContaining({ organization_id: 'mission-org' })
  );
  mocks.inspect.mockClear();
  expect(GET(request('provider=codex&mission_id=MSN-FIXTURE&organization_id=other')).status).toBe(
    403
  );
  expect(mocks.inspect).not.toHaveBeenCalled();
});
it.each(['organizations', 'projects'])(
  'does not create an invisible unscoped destination for a viewer limited to %s',
  (kind) => {
    mocks[kind as 'organizations' | 'projects'].mockReturnValue(['allowed']);
    expect(GET(request()).status).toBe(403);
    expect(mocks.inspect).not.toHaveBeenCalled();
  }
);

const createRequest = (extra: Record<string, unknown>) =>
  ({
    json: async () => ({
      goal: 'fixture',
      speaker: 'reasoning',
      provider: 'codex',
      single_pass: true,
      ...extra,
    }),
  }) as NextRequest;
it.each(['organization', 'project'])(
  'POST rejects same-tenant mission outside viewer %s scope before inspection/create/run',
  async (kind) => {
    mocks.missions.mockReturnValue([
      {
        missionId: 'MSN-FIXTURE',
        tier: 'confidential',
        tenantSlug: 'fixture',
        organizationId: 'foreign-org',
        projectId: 'foreign-project',
      },
    ]);
    if (kind === 'organization') mocks.organizations.mockReturnValue(['allowed-org']);
    else mocks.projects.mockReturnValue(['allowed-project']);
    expect((await POST(createRequest({ mission_id: 'MSN-FIXTURE' }))).status).toBe(404);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  }
);
it.each(['tenant', 'organization_id', 'project_id'])(
  'POST rejects conflicting explicit %s for a linked mission',
  async (field) => {
    mocks.missions.mockReturnValue([
      {
        missionId: 'MSN-FIXTURE',
        tier: 'confidential',
        tenantSlug: 'fixture',
        organizationId: 'mission-org',
        projectId: 'mission-project',
      },
    ]);
    const response = await POST(createRequest({ mission_id: 'MSN-FIXTURE', [field]: 'other' }));
    expect(response.status).toBe(400);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  }
);
it('POST preserves the same canonical mission chain inspected by GET', async () => {
  mocks.missions.mockReturnValue([
    {
      missionId: 'MSN-FIXTURE',
      tier: 'confidential',
      tenantSlug: 'fixture',
      organizationId: 'mission-org',
      projectId: 'mission-project',
    },
  ]);
  GET(request('provider=codex&mission_id=MSN-FIXTURE'));
  const inspectedScope = mocks.inspect.mock.calls[0][1];
  expect((await POST(createRequest({ mission_id: 'MSN-FIXTURE' }))).status).toBe(201);
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ scope: inspectedScope }));
  expect(inspectedScope).toMatchObject({
    tenant_slug: 'fixture',
    organization_id: 'mission-org',
    project_id: 'mission-project',
    mission_id: 'MSN-FIXTURE',
    tier: 'confidential',
  });
});
