import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  receipts: new Map<string, unknown>(),
  requestCreate: vi.fn(),
  readiness: vi.fn(() => ({
    provider: 'claude',
    execution: 'unverified',
    provider_calls: 0,
    checked_at: '2026-10-18T00:00:00.000Z',
    checks: [] as Array<{ id: string; status: string; code: string }>,
  })),
  create: vi.fn((input) => ({ id: 'disc-fixture', ...input })),
  run: vi.fn(async () => undefined),
  read: vi.fn(() => null as unknown),
  submit: vi.fn(),
  review: vi.fn(() => ({ reopened: false })),
  guard: vi.fn(() => null),
  access: vi.fn(() => null),
  scope: vi.fn(() => ({ tenant_slug: 'fixture-tenant' })),
}));
vi.mock('@agent/core/discussion/discussion-create-request', () => ({
  createDiscussionRequest: mocks.requestCreate,
  DiscussionRequestConflictError: class extends Error {},
}));
vi.mock('@agent/core/discussion/discussion-readiness', () => ({
  inspectDiscussionReadiness: mocks.readiness,
}));
vi.mock('@agent/core/discussion/discussion-engine', () => ({ ensureDiscussionRunning: mocks.run }));
vi.mock('@agent/core/discussion/discussion-review', () => ({ reviewDiscussion: mocks.review }));
vi.mock('@agent/core/discussion/discussion-mission', () => ({
  withLiveMissionStatus: (room: unknown) => room,
}));
vi.mock('@agent/core/discussion/discussion-store', () => ({
  createDiscussionRoom: mocks.create,
  readDiscussionRoom: mocks.read,
  sanitizeDiscussionId: (id: string) => id,
  submitDiscussionCommand: mocks.submit,
  listDiscussionRooms: vi.fn(() => []),
  DiscussionUserError: class extends Error {},
}));
vi.mock('../../../lib/api-guard', () => ({
  guardRequest: mocks.guard,
  requireChronosAccess: mocks.access,
}));
vi.mock('../../../lib/discussion-access', () => ({
  resolveDiscussionCreateScope: mocks.scope,
  isDiscussionVisibleToViewer: vi.fn(() => true),
  assertDiscussionVisible: vi.fn(),
}));
vi.mock('../../../lib/su-surface-data', () => ({ buildMissionHistoryItems: vi.fn(() => []) }));
vi.mock('../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: vi.fn(() => ({
    context: {
      role: 'localadmin',
      source: 'token',
      principalId: 'fixture-viewer',
      tenantSlugs: ['fixture-tenant'],
    },
  })),
  strictViewerTier: vi.fn((_viewer, tier) => tier),
  strictViewerScopeOrganizationIds: vi.fn(() => 'all'),
  strictViewerScopeProjectIds: vi.fn(() => 'all'),
  strictViewerScopeTenantSlugs: vi.fn(() => ['fixture-tenant']),
  withViewerExecutionContext: vi.fn((_viewer, fn) => fn()),
  viewerErrorResponse: vi.fn((error, status = 500) =>
    Response.json({ error: String(error) }, { status })
  ),
}));
import { POST } from './route';
import { POST as commandPOST } from './[id]/command/route';
import { POST as reviewPOST } from './[id]/review/route';

const request = (body: unknown) =>
  ({
    json: async () => ({
      request_id: 'cc4e1edb-e0a6-4e53-8fd4-7f5287679a91',
      scope_digest: createHash('sha256')
        .update(JSON.stringify(['fixture-tenant', null, null, null, 'confidential']))
        .digest('hex'),
      ...(body as object),
    }),
  }) as NextRequest;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.receipts.clear();
  mocks.requestCreate.mockImplementation((input) => {
    const previous = mocks.receipts.get(input.request_id);
    if (previous) return { ...(previous as object), should_start: false };
    if (input.rejection) {
      const result = {
        request: { request_id: input.request_id, status: 'rejected', reason: input.rejection },
        should_start: false,
      };
      mocks.receipts.set(input.request_id, result);
      return result;
    }
    const room = mocks.create({
      ...input.input,
      scope: input.scope,
      created_by: input.actor.principal_id,
    });
    const result = {
      request: { request_id: input.request_id, status: 'created', room_id: room.id },
      room,
      should_start: true,
    };
    mocks.receipts.set(input.request_id, result);
    return result;
  });
  mocks.read.mockReturnValue(null);
  mocks.readiness.mockReturnValue({
    provider: 'claude',
    execution: 'unverified',
    provider_calls: 0,
    checked_at: '2026-10-18T00:00:00.000Z',
    checks: [],
  });
});

describe('Discussion HTTP execution bounds (mocked authority and engine)', () => {
  it.each(['pause', 'ask', 'redirect', 'open_vote', 'set_speaker', 'finalize'])(
    'rejects unsupported %s steering on a single brief',
    async (kind) => {
      mocks.read.mockReturnValue({
        id: 'disc-fixture',
        status: 'running',
        config: { single_pass: true },
        scope: {},
      });
      const response = await commandPOST(request({ kind, text: 'fixture' }), {
        params: Promise.resolve({ id: 'disc-fixture' }),
      });
      expect(response.status).toBe(409);
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );
  it('accepts only cancellation while a single brief runs', async () => {
    mocks.read.mockReturnValue({
      id: 'disc-fixture',
      status: 'running',
      config: { single_pass: true },
      scope: {},
    });
    const response = await commandPOST(request({ kind: 'stop' }), {
      params: Promise.resolve({ id: 'disc-fixture' }),
    });
    expect(response.status).toBe(202);
    expect(mocks.submit).toHaveBeenCalledWith('disc-fixture', 'fixture-viewer', { kind: 'stop' });
  });

  it.each(['reasoning', 'auto'])(
    'does not discard a %s decision through automatic reopen',
    async (speaker) => {
      mocks.read.mockReturnValue({
        id: 'disc-fixture',
        status: 'concluded',
        config: { speaker },
        scope: { tenant_slug: 'fixture-tenant' },
      });
      const response = await reviewPOST(request({ verdict: 'request-changes', note: 'revise' }), {
        params: Promise.resolve({ id: 'disc-fixture' }),
      });
      expect(response.status).toBe(409);
      expect(mocks.review).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );
  it.each(['finalize', 'regenerate', 'resume', 'inject'])(
    'rejects %s on failed rooms without another call',
    async (kind) => {
      mocks.read.mockReturnValue({
        id: 'disc-fixture',
        status: 'failed',
        scope: { tenant_slug: 'fixture-tenant' },
      });
      const response = await commandPOST(request({ kind, text: 'fixture' }), {
        params: Promise.resolve({ id: 'disc-fixture' }),
      });
      expect(response.status).toBe(409);
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );
  it.each(['auto', 'reasoning'])(
    'rejects %s with no provider before create/run',
    async (speaker) => {
      expect((await POST(request({ goal: 'Public fixture text', speaker }))).status).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    }
  );
  it('preserves a single brief invocation despite inflated client limits', async () => {
    const response = await POST(
      request({
        goal: 'Public fixture text',
        speaker: 'reasoning',
        provider: 'claude',
        single_pass: true,
        max_rounds: 8,
        max_provider_calls: 500,
        provider_timeout_ms: 999999,
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { tenant_slug: 'fixture-tenant', tier: 'confidential' },
        created_by: 'fixture-viewer',
        config: expect.objectContaining({
          speaker: 'reasoning',
          provider: 'claude',
          single_pass: true,
          max_rounds: 1,
          max_provider_calls: 1,
          provider_timeout_ms: 60000,
        }),
      })
    );
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it('does not accept a client public tier as authorization', async () => {
    await POST(request({ goal: 'fixture', speaker: 'scripted', tier: 'public' }));
    expect(mocks.create.mock.calls[0]?.[0].scope.tier).toBe('confidential');
  });
  it('keeps explicit scripted mode offline', async () => {
    await POST(
      request({ goal: 'fixture', speaker: 'scripted', provider: 'codex', single_pass: true })
    );
    expect(mocks.create.mock.calls[0]?.[0].config).toMatchObject({
      speaker: 'scripted',
      max_provider_calls: 0,
    });
    expect(mocks.create.mock.calls[0]?.[0].config).not.toHaveProperty('provider');
  });
  it('does not create or execute after an access denial', async () => {
    mocks.access.mockReturnValueOnce(Response.json({ error: 'denied' }, { status: 403 }) as never);
    expect((await POST(request({ goal: 'fixture', speaker: 'scripted' }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

it('rechecks a known prerequisite blocker before creating a room or consuming its execution claim', async () => {
  mocks.readiness.mockReturnValue({
    provider: 'claude',
    execution: 'unverified',
    provider_calls: 0,
    checked_at: '2026-10-18T00:00:00.000Z',
    checks: [{ id: 'egress_policy', status: 'blocked', code: 'egress_denied' }],
  });
  const response = await POST(
    request({ goal: 'fixture', speaker: 'reasoning', provider: 'claude', single_pass: true })
  );
  expect(response.status).toBe(200);
  expect((await response.json()).request).toMatchObject({
    status: 'rejected',
    reason: 'prerequisites_blocked',
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it('does not launch twice when the original create response was lost', async () => {
  const body = {
    request_id: '9fdfb84a-90ec-4fee-a07b-a7a60f6543df',
    goal: 'Public fixture',
    speaker: 'scripted',
  };
  await POST(request(body));
  await POST(request(body));
  expect(mocks.run).toHaveBeenCalledTimes(1);
});

it('does not create another room when canonical scope gains a previously absent project', async () => {
  const body = { goal: 'Public fixture', speaker: 'scripted' };
  expect((await POST(request(body))).status).toBe(201);
  mocks.scope.mockReturnValueOnce({
    tenant_slug: 'fixture-tenant',
    project_id: 'PRJ-LATER',
  } as never);
  expect((await POST(request(body))).status).not.toBe(201);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
