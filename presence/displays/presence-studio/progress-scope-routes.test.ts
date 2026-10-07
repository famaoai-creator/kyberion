import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type express from 'express';
const f = vi.hoisted(() => ({
  accept: vi.fn(),
  mark: vi.fn(),
  entryTenant: 'alpha-team',
  artifactTenant: 'alpha-team',
  artifactTask: undefined as string | undefined,
  findTask: vi.fn(),
  entryScope: undefined as undefined | Record<string, unknown>,
}));
vi.mock('./conversation-routes.js', () => ({ registerConversationRoutes: () => {} }));
vi.mock('./presence-studio-runtime-data.js', () => ({
  isAllowedArtifactDownloadPath: () => true,
  findTaskSession: (id: string) => f.findTask(id),
  resolveSafeExistingFile: (path: string) => path,
  safeParsePresenceStudioRequestBody: (body: unknown) => body,
  presenceStudioWireError: () => ({ ok: false, error: 'scope denied' }),
  presenceStudioAuditLine: () => 'audit fixture',
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  resolveMemberByPrincipal: () => null,
  memberBindingDenied: () => false,
}));
vi.mock('@agent/core/task/task-session', () => ({
  listTaskSessions: () => [
    {
      session_id: 'task-1',
      goal: { summary: 'Work' },
      status: 'running',
      correlation_id: 'real-request-1',
      project_context: { tenant_slug: 'alpha-team' },
    },
  ],
}));
vi.mock('@agent/core/workforce/artifact-record', () => ({
  listArtifactRecords: () => [
    {
      artifact_id: 'artifact-1',
      path: 'active/shared/artifacts/fixture.txt',
      kind: 'doc',
      tenant_slug: f.artifactTenant,
      task_session_id: f.artifactTask,
    },
  ],
}));
vi.mock('@agent/core/deliverable-inbox', () => ({
  listInboxEntries: () => [
    {
      entry_id: 'entry-1',
      tenant_slug: f.entryTenant,
      ...(f.entryScope ? { scope: f.entryScope } : {}),
      artifact_paths: ['active/shared/artifacts/fixture.txt'],
      status: 'read',
    },
  ],
  acceptInboxEntryWithHumanReceipt: f.accept,
  markInboxEntry: f.mark,
}));
import { registerFrontDeskRoutes } from './front-desk-routes.js';
const handlers = new Map<string, express.RequestHandler>();
registerFrontDeskRoutes({
  get: (p: string, h: express.RequestHandler) => handlers.set('GET ' + p, h),
  post: (p: string, h: express.RequestHandler) => handlers.set('POST ' + p, h),
} as unknown as express.Express);
function call(
  method = 'GET',
  body: unknown = {},
  tenant = 'alpha-team',
  selection: Record<string, string> = {},
  detail = false,
  detailId = 'artifact-1'
) {
  const req = {
    body,
    query: { tenant, ...selection },
    params: { id: detail ? detailId : 'entry-1' },
    headers: { host: '127.0.0.1:3031' },
    socket: { remoteAddress: '127.0.0.1' },
    path: method === 'GET' ? '/api/progress' : '/api/outcomes/entry-1/verdict',
    method,
  } as unknown as express.Request;
  const res = {
    statusCode: 200,
    body: {} as Record<string, unknown>,
    setHeader() {
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value as Record<string, unknown>;
      return this;
    },
  };
  handlers.get(
    method === 'GET'
      ? detail
        ? 'GET /api/progress/:id'
        : 'GET /api/progress'
      : 'POST /api/outcomes/:id/verdict'
  )!(req, res as unknown as express.Response, vi.fn());
  return res;
}
beforeEach(() => {
  vi.stubEnv('KYBERION_TENANT', 'alpha-team');
  f.entryTenant = 'alpha-team';
  f.artifactTenant = 'alpha-team';
  f.artifactTask = undefined;
  f.findTask.mockReset().mockReturnValue(null);
  f.entryScope = undefined;
  f.accept.mockReset().mockReturnValue({ entry_id: 'entry-1', status: 'accepted' });
  f.mark.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe('progress viewer scope HTTP integration', () => {
  it('supplies server scope identity and real task correlation to the client', () => {
    const res = call();
    expect(res.statusCode).toBe(200);
    expect(res.body.viewer_scope_id).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'task-1', correlation_id: 'real-request-1' }),
      ])
    );
  });
  it('accepts a matching scope marker and rejects an obsolete marker before mutation', () => {
    const id = call().body.viewer_scope_id;
    expect(call('POST', { status: 'accepted', viewer_scope_id: 'f'.repeat(64) }).statusCode).toBe(
      409
    );
    expect(f.accept).not.toHaveBeenCalled();
    expect(call('POST', { status: 'accepted', viewer_scope_id: id }).statusCode).toBe(200);
    expect(f.accept).toHaveBeenCalledTimes(1);
  });
  it('denies an entry outside the selected tenant even for a loopback administrator', () => {
    f.entryTenant = 'beta-team';
    expect(call('POST', { status: 'accepted' }).statusCode).toBe(403);
    expect(f.accept).not.toHaveBeenCalled();
  });
  it('changes the marker when selected tenant changes and never widens a server-bound viewer', () => {
    expect(call('GET', {}, 'beta-team').statusCode).toBe(403);
    vi.stubEnv('KYBERION_TENANT', '');
    const alpha = call().body.viewer_scope_id;
    const beta = call('GET', {}, 'beta-team').body.viewer_scope_id;
    expect(alpha).not.toBe(beta);
    expect(
      call('POST', { status: 'accepted', viewer_scope_id: alpha }, 'beta-team').statusCode
    ).toBe(409);
    expect(f.accept).not.toHaveBeenCalled();
  });
});

it('hides unknown org/project metadata and changes scope receipt on explicit narrowing', () => {
  const tenant = call();
  const project = call('GET', {}, 'alpha-team', {
    organizationId: 'org-a',
    projectId: 'project-a',
  });
  expect(project.statusCode).toBe(200);
  expect(project.body.active).toEqual([]);
  expect(project.body.viewer_scope_id).not.toBe(tenant.body.viewer_scope_id);
  expect(
    call('POST', { status: 'accepted' }, 'alpha-team', {
      organizationId: 'org-a',
      projectId: 'project-a',
    }).statusCode
  ).toBe(403);
  expect(f.accept).not.toHaveBeenCalled();
});
it('allows only matching canonical project verdict metadata and rejects conflicts', () => {
  const selection = { organizationId: 'org-a', projectId: 'project-a' };
  f.entryScope = {
    scope_kind: 'project',
    tier: 'confidential',
    tenant_slug: 'alpha-team',
    organization_id: 'org-a',
    project_id: 'project-a',
  };
  expect(call('POST', { status: 'accepted' }, 'alpha-team', selection).statusCode).toBe(200);
  f.accept.mockClear();
  f.entryScope.project_id = 'project-b';
  expect(call('POST', { status: 'accepted' }, 'alpha-team', selection).statusCode).toBe(403);
  expect(f.accept).not.toHaveBeenCalled();
});

it('does not expose an out-of-scope inbox verdict through artifact detail', () => {
  f.entryTenant = 'beta-team';
  const result = call('GET', {}, 'alpha-team', {}, true);
  expect(result.statusCode).toBe(200);
  expect(JSON.stringify(result.body)).not.toContain('read');
});
it('checks artifact scope before following its in-scope task association', () => {
  f.artifactTenant = 'beta-team';
  f.artifactTask = 'task-1';
  f.findTask.mockImplementation((id: string) =>
    id === 'task-1'
      ? {
          session_id: 'task-1',
          status: 'running',
          goal: { summary: 'private association' },
          tenant_slug: 'alpha-team',
        }
      : null
  );
  const result = call('GET', {}, 'alpha-team', {}, true);
  expect(result.statusCode).toBe(404);
  expect(f.findTask).not.toHaveBeenCalledWith('task-1');
});

describe('explicit progress target HTTP boundaries', () => {
  const selected = { organizationId: 'org-a', projectId: 'project-a' };
  const exact = 'task/日本語 %2F';
  const session = (tenant = 'alpha-team', project = 'project-a') => ({
    session_id: exact,
    goal: { summary: 'Scoped task detail' },
    status: 'running',
    scope: {
      scope_kind: 'project',
      tier: 'confidential',
      tenant_slug: tenant,
      organization_id: 'org-a',
      project_id: project,
    },
  });
  it('resolves only the exact decoded route identifier within the matching project', () => {
    f.findTask.mockImplementation((id: string) => (id === exact ? session() : null));
    const allowed = call('GET', {}, 'alpha-team', selected, true, exact);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.item).toMatchObject({ requested: 'Scoped task detail' });
    expect(f.findTask).toHaveBeenCalledWith(exact);
    expect(
      call('GET', {}, 'alpha-team', selected, true, encodeURIComponent(exact)).statusCode
    ).toBe(404);
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'tenant', 'project', 'organization'])(
    'keeps %s targets unavailable without unrelated fallback',
    (reason) => {
      f.findTask.mockImplementation((id: string) => {
        if (id !== exact || reason === 'unknown') return null;
        const value = session(
          reason === 'tenant' ? 'beta-team' : 'alpha-team',
          reason === 'project' ? 'project-b' : 'project-a'
        );
        if (reason === 'organization') value.scope.organization_id = 'org-b';
        return value;
      });
      const denied = call('GET', {}, 'alpha-team', selected, true, exact);
      expect(denied.statusCode).toBe(404);
      expect(denied.body.item).toBeUndefined();
      expect(JSON.stringify(denied.body)).not.toContain('Scoped task detail');
      expect(call().body.active).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'task-1' })])
      );
      expect(f.accept).not.toHaveBeenCalled();
      expect(f.mark).not.toHaveBeenCalled();
    }
  );
});
