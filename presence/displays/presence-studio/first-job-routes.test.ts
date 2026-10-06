import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type express from 'express';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type {
  FrontDeskExecutionMapping,
  FrontDeskExecutionProjection,
} from '@agent/core/surface/front-desk-execution-contract';
const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  mappings: [] as FrontDeskExecutionMapping[],
  writes: 0,
  locks: 0,
  loads: 0,
  revokeAt: 0,
  charterReads: 0,
  revokeCharterAt: 0,
  digest: 'a'.repeat(64),
  projections: new Map<string, FrontDeskExecutionProjection>(),
  run: vi.fn(),
  charter: undefined as DotCharter | undefined,
}));
vi.mock('@agent/core/dot/dot-charter', async (original) => ({
  ...(await original<typeof import('@agent/core/dot/dot-charter')>()),
  findDotCharter: () => {
    state.charterReads++;
    if (state.revokeCharterAt && state.charterReads >= state.revokeCharterAt && state.charter)
      state.charter.status = 'paused';
    return state.charter
      ? { path: 'dots/receipt-dot.json', charter: structuredClone(state.charter) }
      : undefined;
  },
}));
vi.mock('@agent/core/surface/channel-surface', () => ({
  runSurfaceMessageConversation: state.run,
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/lock-utils', () => ({
  withLockSync: (_key: string, fn: () => unknown) => {
    state.locks++;
    return fn();
  },
}));
vi.mock('@agent/core/workforce/artifact-store', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(state.files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) => {
    state.writes++;
    state.files.set(path, structuredClone(value));
  },
}));
vi.mock('@agent/core/workforce/work-coordination', async (original) => ({
  ...(await original<typeof import('@agent/core/workforce/work-coordination')>()),
  getWorkItem: () => undefined,
}));
vi.mock('@agent/core/surface/front-desk-execution-status', () => ({
  projectFrontDeskExecution: (
    _viewer: unknown,
    binding: { request_id: string; config_digest: string }
  ) =>
    state.mappings.length && binding.config_digest === state.digest
      ? state.projections.get(binding.request_id)
      : undefined,
}));
vi.mock('@agent/core/surface/front-desk-execution-contract', async (original) => ({
  ...(await original<typeof import('@agent/core/surface/front-desk-execution-contract')>()),
  loadFrontDeskExecutionPolicy: () => {
    state.loads++;
    if (state.revokeAt && state.loads >= state.revokeAt) state.mappings = [];
    return { version: 1, mappings: structuredClone(state.mappings) };
  },
  frontDeskMappingDigest: () => state.digest,
  getFrontDeskExecutionMapping: (binding: { mapping_id: string; config_digest: string }) =>
    binding.config_digest === state.digest
      ? structuredClone(state.mappings.find((entry) => entry.id === binding.mapping_id))
      : undefined,
}));
import { registerFirstJobRoutes } from './first-job-routes.js';
import {
  resolveFirstJobViewer,
  readFirstJobSnapshot,
  type FirstJobSnapshot,
} from '@agent/core/surface/first-job';
type TestBody = Omit<Partial<FirstJobSnapshot>, 'ok'> & {
  ok?: boolean;
  error?: string;
  replayed?: boolean;
};
import {
  reserveConversationTurn,
  conversationRef,
  readConversationHistory,
  listConfiguredFrontDeskExecutions,
  inspectFrontDeskExecution,
} from '@agent/core/surface/front-desk-conversation-store';
import {
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
  FRONT_DESK_RECEIPT_VERSION,
} from '@agent/core/surface/front-desk-execution-contract';
const id = (n = 1) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const viewer = {
  principalId: 'human:presence-studio-localadmin',
  source: 'loopback' as const,
  role: 'localadmin' as const,
  tenantSlugs: ['alpha-team'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public' as const],
};
const mapping = (): FrontDeskExecutionMapping => ({
  id: 'local-diagnostic',
  viewer: structuredClone(viewer),
  dotId: 'receipt-dot',
  exactCommand: FRONT_DESK_RECEIPT_COMMAND,
  pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
});
const handlers = new Map<string, express.RequestHandler>();
registerFirstJobRoutes({
  get: (path: string, fn: express.RequestHandler) => handlers.set('GET ' + path, fn),
  post: (path: string, fn: express.RequestHandler) => handlers.set('POST ' + path, fn),
} as unknown as express.Express);
async function request(
  method = 'GET',
  body: unknown = {},
  options: {
    query?: Record<string, unknown>;
    address?: string;
    headers?: Record<string, string | undefined>;
  } = {}
) {
  const req = {
    body,
    query: options.query ?? {},
    method,
    headers: { host: '127.0.0.1:3031', origin: 'http://127.0.0.1:3031', ...options.headers },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
  } as unknown as express.Request;
  const response = {
    statusCode: 200,
    body: {} as TestBody,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value as TestBody;
      return this;
    },
  };
  await handlers.get(method + ' /api/first-job')!(
    req,
    response as unknown as express.Response,
    vi.fn()
  );
  return response;
}
beforeEach(() => {
  vi.stubEnv('KYBERION_TENANT', 'alpha-team');
  state.charter = {
    kind: 'dot-charter',
    dot_id: 'receipt-dot',
    version: '1.0.0',
    title: 'Diagnostic',
    purpose: 'Diagnostic',
    status: 'active',
    scope: {
      tier: 'public',
      tenant_slug: 'alpha-team',
      organization_id: 'org-a',
      project_id: 'project-a',
    },
    goal: { statement: 'Return verified receipts' },
    attention: { triggers: [] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: [FRONT_DESK_RECEIPT_PIPELINE],
    },
    decisions: { default_decision: 'approve', escalate_channel: 'surface' },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: 'diagnostic', execution_mode: 'front_desk_diagnostic' },
  };
  state.files.clear();
  state.mappings = [mapping()];
  state.writes = 0;
  state.locks = 0;
  state.loads = 0;
  state.revokeAt = 0;
  state.charterReads = 0;
  state.revokeCharterAt = 0;
  state.digest = 'a'.repeat(64);
  state.projections.clear();
  state.run.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe('first-job local diagnostic boundary', () => {
  it('keeps supported aliases working and rejects unsupported locales in GET/POST/domain reads', async () => {
    for (const locale of ['en-US', 'EN_us', 'jaJP'])
      expect((await request('GET', {}, { query: { locale } })).statusCode).toBe(200);
    for (const locale of ['zz', 'invalid', 'C']) {
      expect((await request('GET', {}, { query: { locale } })).statusCode).toBe(400);
      expect(
        (await request('POST', { action: 'start', request_id: id(), locale })).statusCode
      ).toBe(400);
      expect(() => readFirstJobSnapshot(viewer, { locale })).toThrow('first_job_invalid_locale');
    }
    expect(state.writes).toBe(0);
  });

  it('derives a public-only singleton scope without replacing authenticated identity', async () => {
    const result = await request();
    expect(result.body.readiness).toEqual({ ready: true, status: 'diagnostic_mapping_ready' });
    expect(result.body.scope).toEqual({
      tenant: 'alpha-team',
      organizationId: 'org-a',
      projectId: 'project-a',
      tier: 'public',
    });
    expect(result.body.sessionId).toBe(conversationRef(viewer).sessionId);
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(state.writes).toBe(0);
    expect(state.locks).toBe(0);
  });
  it('reports absent, mismatched and ambiguous mappings without exposing other scopes', async () => {
    state.mappings = [];
    expect((await request()).body.readiness.status).toBe('mapping_missing');
    state.mappings = [
      { ...mapping(), viewer: { ...viewer, principalId: 'human:concierge-localadmin' } },
    ];
    expect((await request()).body.readiness.status).toBe('mapping_mismatch');
    state.mappings = [
      mapping(),
      { ...mapping(), id: 'other', viewer: { ...viewer, projectIds: ['project-b'] } },
    ];
    const result = await request();
    expect(result.body.readiness.status).toBe('mapping_ambiguous');
    expect(result.body.scope).toBeUndefined();
  });
  it('retains member, source and role and never widens restricted scopes', () => {
    const auth = {
      ...viewer,
      memberId: 'alice',
      tierAccess: ['public' as const, 'confidential' as const],
    };
    expect(resolveFirstJobViewer(auth).ready).toBe(false);
    state.mappings = [{ ...mapping(), viewer: { ...viewer, memberId: 'alice' } }];
    expect(resolveFirstJobViewer(auth)).toMatchObject({
      ready: true,
      viewer: { ...viewer, memberId: 'alice' },
    });
    for (const change of [
      { tenantSlugs: ['other'] },
      { organizationIds: ['other'] },
      { projectIds: ['other'] },
      { source: 'token' as const },
      { source: 'anonymous' as const },
      { role: 'readonly' as const },
      { tierAccess: ['confidential' as const] },
    ])
      expect(resolveFirstJobViewer({ ...auth, ...change }).ready).toBe(false);
  });
  it.each(['192.0.2.1', '', '10.0.0.1'])(
    'rejects remote/token/anonymous socket %s even with forged forwarding',
    async (address) => {
      const result = await request(
        'POST',
        { action: 'start', request_id: id() },
        {
          address,
          headers: { 'x-forwarded-for': '127.0.0.1', authorization: 'Bearer forged' },
        }
      );
      expect(result.statusCode).toBe(403);
      expect(state.writes).toBe(0);
    }
  );
  it.each([
    { origin: 'https://evil.example' },
    { origin: undefined },
    { origin: 'null' },
    { origin: 'https://127.0.0.1:3031' },
    { origin: 'http://127.0.0.1:3031', 'sec-fetch-site': 'cross-site' },
    { host: 'evil.example:3031', origin: 'http://evil.example:3031' },
  ])('enforces explicit same-origin POST with no token bypass %#', async (headers) => {
    const result = await request(
      'POST',
      { action: 'start', request_id: id() },
      { headers: { ...headers, authorization: 'Bearer forged' } }
    );
    expect(result.statusCode).toBe(403);
    expect(state.writes).toBe(0);
  });
  it('pins GET to loopback hosts and rejects caller narrowing or stale sessions without writes', async () => {
    expect((await request('GET', {}, { headers: { host: 'evil.example:3031' } })).statusCode).toBe(
      403
    );
    expect((await request('GET', {}, { query: { tenant: 'other' } })).statusCode).toBe(400);
    expect(
      (
        await request('POST', {
          action: 'start',
          request_id: id(),
          session_id: 'concierge-' + 'f'.repeat(64),
        })
      ).statusCode
    ).toBe(409);
    expect(state.writes).toBe(0);
  });
  it('never uses all, multiple or protected mapping scopes as a public singleton', () => {
    for (const override of [
      { tenantSlugs: 'all' as const },
      { organizationIds: 'all' as const },
      { projectIds: 'all' as const },
      { projectIds: ['one', 'two'] },
      { tierAccess: ['confidential' as const] },
    ]) {
      state.mappings = [{ ...mapping(), viewer: { ...viewer, ...override } }];
      expect(resolveFirstJobViewer(viewer).ready).toBe(false);
    }
  });
  it('admits only explicitly tenant-bound diagnostic charters without inventing org/project IDs', async () => {
    state.mappings = [
      { ...mapping(), viewer: { ...viewer, organizationIds: 'all', projectIds: 'all' } },
    ];
    state.charter!.scope = { tier: 'public', tenant_slug: 'alpha-team' };
    const unbound = { ...viewer, organizationIds: 'all' as const, projectIds: 'all' as const };
    expect(resolveFirstJobViewer(unbound)).toMatchObject({ ready: true, viewer: unbound });
    expect(resolveFirstJobViewer(viewer).ready).toBe(false);
    expect(resolveFirstJobViewer({ ...unbound, organizationIds: ['other'] }).ready).toBe(false);
    const start = await request('POST', { action: 'start', request_id: id() });
    expect(start.body.scope).toEqual({ tenant: 'alpha-team', tier: 'public' });
    state.projections.set(id(), {
      status: 'work_completed',
      text: 'done',
      artifactPath: '/private/path',
      artifactSha256: 'b'.repeat(64),
    });
    const revision = await request('POST', {
      action: 'revise',
      request_id: id(2),
      artifactRevision: { requestId: id(), revision: 1, sha256: 'b'.repeat(64), format: 'compact' },
    });
    expect(revision.body.ok).toBe(true);
    expect(revision.body.tasks).toHaveLength(2);
    expect(
      listConfiguredFrontDeskExecutions().map((entry) => entry.binding.diagnostic_protocol)
    ).toEqual(['first-job-v1', 'first-job-v1']);
    state.charter!.scope.organization_id = 'other';
    expect((await request()).body.readiness.status).toBe('mapping_unavailable');
    expect((await request('POST', { action: 'start', request_id: id(3) })).statusCode).toBe(409);
  });
  it('persists diagnostic admission provenance and rejects fresh generic reloads or stripped bindings', async () => {
    expect((await request('POST', { action: 'start', request_id: id() })).body.ok).toBe(true);
    const binding = listConfiguredFrontDeskExecutions()[0].binding;
    expect(binding.diagnostic_protocol).toBe('first-job-v1');
    const writes = state.writes;
    const { diagnostic_protocol: _marker, ...stripped } = binding;
    expect(inspectFrontDeskExecution(stripped, state.charter!)).toMatchObject({
      ok: false,
      reason: 'request_mismatch',
    });
    delete state.charter!.runtime.execution_mode;
    expect(inspectFrontDeskExecution(binding, structuredClone(state.charter!))).toMatchObject({
      ok: false,
      reason: 'diagnostic_provenance_requires_active_mode',
    });
    expect(state.writes).toBe(writes);
  });
  it('requires an active bounded diagnostic charter and rejects restored generic model wakes', async () => {
    state.charter!.runtime.execution_mode = undefined;
    expect((await request()).body.readiness.status).toBe('mapping_unavailable');
    state.charter!.runtime.execution_mode = 'front_desk_diagnostic';
    state.charter!.status = 'paused';
    expect((await request()).body.readiness.status).toBe('mapping_unavailable');
    state.charter = undefined;
    expect((await request('POST', { action: 'start', request_id: id() })).statusCode).toBe(409);
    expect(state.writes).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('records exactly one fixed diagnostic per request UUID and keeps GET read-only', async () => {
    const start = { action: 'start', request_id: id() };
    expect((await request('POST', start)).body).toMatchObject({
      ok: true,
      mode: 'intake',
      replayed: false,
    });
    const writes = state.writes;
    expect((await request('POST', start)).body).toMatchObject({
      ok: true,
      mode: 'history',
      replayed: true,
    });
    expect(state.writes).toBe(writes);
    const locks = state.locks;
    const before = JSON.stringify([...state.files]);
    const get = await request();
    await request();
    expect(get.body.tasks).toHaveLength(1);
    expect(JSON.stringify([...state.files])).toBe(before);
    expect(state.writes).toBe(writes);
    expect(state.locks).toBe(locks);
    const stored = JSON.stringify([...state.files]);
    expect(stored).toContain('human:presence-studio-localadmin');
    expect(stored).not.toContain('human:concierge-localadmin');
    expect(state.run).not.toHaveBeenCalled();
  });
  it('rejects client text, scope, approval and guessed revision without storing it', async () => {
    for (const extra of [
      { text: 'protected private secret' },
      { tenant: 'other' },
      { tier: 'personal' },
      { approved: true },
    ])
      expect(
        (await request('POST', { action: 'start', request_id: id(), ...extra })).statusCode
      ).toBe(400);
    expect(
      (
        await request('POST', {
          action: 'revise',
          request_id: id(2),
          artifactRevision: {
            requestId: id(),
            revision: 1,
            sha256: 'a'.repeat(64),
            format: 'compact',
          },
        })
      ).statusCode
    ).toBe(409);
    expect(state.writes).toBe(0);
    expect(state.files.size).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('fails closed if configuration is revoked between readiness and reservation', async () => {
    state.revokeAt = 2;
    const result = await request('POST', { action: 'start', request_id: id() });
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toBe('first_job_diagnostic_admission_required');
    expect(state.writes).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('fails closed if diagnostic charter is revoked between readiness and atomic reservation', async () => {
    state.revokeCharterAt = 2;
    const result = await request('POST', { action: 'start', request_id: id() });
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toBe('first_job_diagnostic_admission_required');
    expect(state.writes).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('never replays an ordinary non-diagnostic turn as admitted execution', async () => {
    state.mappings = [];
    reserveConversationTurn(viewer, FRONT_DESK_RECEIPT_COMMAND, id());
    state.mappings = [mapping()];
    const writes = state.writes;
    const result = await request('POST', { action: 'start', request_id: id() });
    expect(result.statusCode).toBe(409);
    expect(state.writes).toBe(writes);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('detects revoked setup for a known session and does not load its old history', async () => {
    const first = await request('POST', { action: 'start', request_id: id() });
    state.mappings = [];
    const read = await request('GET', {}, { query: { session_id: first.body.sessionId } });
    expect(read.body.readiness.status).toBe('mapping_changed');
    expect(read.body.messages).toEqual([]);
    expect((await request('POST', { action: 'start', request_id: id() })).statusCode).toBe(409);
  });
  it('uses verified artifact identity for immutable revision, retains old receipt, and omits paths', async () => {
    await request('POST', { action: 'start', request_id: id() });
    state.projections.set(id(), {
      status: 'work_completed',
      text: 'private /secret/output',
      artifactPath: '/secret/output',
      artifactSha256: 'b'.repeat(64),
    });
    const history = await request();
    const artifact = history.body.messages.find((message) => message.artifact)?.artifact;
    expect(artifact).toEqual({
      requestId: id(),
      revision: 1,
      sha256: 'b'.repeat(64),
      format: 'readable',
      canRevise: true,
    });
    expect(JSON.stringify(history.body)).not.toContain('/secret');
    const revision = {
      action: 'revise',
      request_id: id(2),
      artifactRevision: {
        requestId: artifact.requestId,
        revision: artifact.revision,
        sha256: artifact.sha256,
        format: 'compact',
      },
    };
    expect((await request('POST', revision)).body.ok).toBe(true);
    expect((await request('POST', revision)).body.replayed).toBe(true);
    const current = await request();
    expect(current.body.tasks).toHaveLength(2);
    expect(current.body.messages.find((message) => message.artifact)?.artifact.canRevise).toBe(
      false
    );
    expect((await request('POST', { ...revision, request_id: id(3) })).statusCode).toBe(409);
    state.digest = 'c'.repeat(64);
    expect((await request('POST', revision)).statusCode).toBe(409);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('hides arbitrary legacy text in the same public transcript', async () => {
    reserveConversationTurn(viewer, 'protected /internal/path', id(8));
    expect(readConversationHistory(viewer, { readOnly: true }).messages.length).toBeGreaterThan(0);
    const result = await request();
    expect(result.body.messages).toEqual([]);
    expect(result.body.tasks).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain('/internal');
  });
});
