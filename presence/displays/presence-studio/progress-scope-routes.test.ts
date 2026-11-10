import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type express from 'express';
// GET /api/progress stays in Studio for the 頼む page's recent-requests list;
// the item detail and the verdict mutation left with the 進み具合 page
// (Concierge 仕事 › 依頼, scoped by its own route tests).
const f = vi.hoisted(() => ({
  entryTenant: 'alpha-team',
  taskStatus: 'executing',
  awaitingInput: false,
  artifactTenant: 'alpha-team',
  artifactTask: undefined as string | undefined,
  entryScope: undefined as undefined | Record<string, unknown>,
}));
vi.mock('./conversation-routes.js', () => ({ registerConversationRoutes: () => {} }));
vi.mock('./presence-studio-runtime-data.js', () => ({
  isAllowedArtifactDownloadPath: () => true,
  resolveSafeExistingFile: (path: string) => path,
  presenceStudioWireError: () => ({ ok: false, error: 'scope denied' }),
}));
vi.mock('@agent/core/authority', () => ({
  // S4: store facades open their declared store grant (withStoreGrant).
  withStoreGrant: (_name: string, fn: () => unknown) => fn(),
  withStoreGrantAsync: async (_name: string, fn: () => unknown) => fn(),
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
      status: f.taskStatus,
      control: { awaiting_user_input: f.awaitingInput },
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
}));
import { registerFrontDeskRoutes } from './front-desk-routes.js';
const handlers = new Map<string, express.RequestHandler>();
registerFrontDeskRoutes({
  get: (p: string, h: express.RequestHandler) => handlers.set('GET ' + p, h),
  post: (p: string, h: express.RequestHandler) => handlers.set('POST ' + p, h),
} as unknown as express.Express);
function call(tenant = 'alpha-team', selection: Record<string, string> = {}, remoteToken?: string) {
  const req = {
    query: { tenant, ...selection },
    params: {},
    headers: remoteToken
      ? { host: '127.0.0.1:3031', authorization: `Bearer ${remoteToken}` }
      : { host: '127.0.0.1:3031' },
    socket: { remoteAddress: remoteToken ? '198.51.100.24' : '127.0.0.1' },
    path: '/api/progress',
    method: 'GET',
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
  handlers.get('GET /api/progress')!(req, res as unknown as express.Response, vi.fn());
  return res;
}
beforeEach(() => {
  vi.stubEnv('KYBERION_TENANT', 'alpha-team');
  f.entryTenant = 'alpha-team';
  f.taskStatus = 'executing';
  f.awaitingInput = false;
  f.artifactTenant = 'alpha-team';
  f.artifactTask = undefined;
  f.entryScope = undefined;
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
  it('lists an artifact only with its in-scope inbox status', () => {
    expect(call().body.delivered).toEqual([
      expect.objectContaining({ id: 'artifact-1', status: 'read', entry_id: 'entry-1' }),
    ]);
    f.entryTenant = 'beta-team';
    expect(call().body.delivered).toEqual([
      expect.objectContaining({ id: 'artifact-1', status: 'delivered', can_verdict: false }),
    ]);
    f.artifactTenant = 'beta-team';
    expect(call().body.delivered).toEqual([]);
  });
  it('never widens a token viewer bound to the server tenant', () => {
    vi.stubEnv('PRESENCE_STUDIO_TOKEN', 'studio-token');
    expect(call('alpha-team', {}, 'studio-token').statusCode).toBe(200);
    expect(call('beta-team', {}, 'studio-token').statusCode).toBe(403);
  });
  it('changes the marker when the loopback owner switches tenant (FD-01)', () => {
    const alpha = call().body.viewer_scope_id;
    const beta = call('beta-team').body.viewer_scope_id;
    expect(alpha).not.toBe(beta);
  });
});

it('hides unknown org/project metadata and changes scope receipt on explicit narrowing', () => {
  const tenant = call();
  const project = call('alpha-team', { organizationId: 'org-a', projectId: 'project-a' });
  expect(project.statusCode).toBe(200);
  expect(project.body.active).toEqual([]);
  expect(project.body.viewer_scope_id).not.toBe(tenant.body.viewer_scope_id);
});

it('propagates explicit task input wait to the list', () => {
  f.awaitingInput = true;
  expect(call().body.active).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'task-1', task_state: 'awaiting_input' }),
    ])
  );
});
