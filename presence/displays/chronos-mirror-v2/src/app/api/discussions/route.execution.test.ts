import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  create: vi.fn((input) => ({ id: 'disc-fixture', ...input })),
  run: vi.fn(async () => undefined),
  read: vi.fn(() => null as unknown),
  submit: vi.fn(),
  review: vi.fn(() => ({ reopened: false })),
  guard: vi.fn(() => null),
  access: vi.fn(() => null),
  scope: vi.fn(() => ({ tenant_slug: 'fixture-tenant' })),
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
    context: { role: 'localadmin', principalId: 'fixture-viewer' },
  })),
  strictViewerScopeTenantSlugs: vi.fn(() => ['fixture-tenant']),
  withViewerExecutionContext: vi.fn((_viewer, fn) => fn()),
  viewerErrorResponse: vi.fn((error, status = 500) =>
    Response.json({ error: String(error) }, { status })
  ),
}));
import { POST } from './route';
import { POST as commandPOST } from './[id]/command/route';
import { POST as reviewPOST } from './[id]/review/route';

const request = (body: unknown) => ({ json: async () => body }) as NextRequest;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockReturnValue(null);
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
        scope: { tenant_slug: 'fixture-tenant' },
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
    expect(mocks.create.mock.calls[0]?.[0].scope).not.toHaveProperty('tier');
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
