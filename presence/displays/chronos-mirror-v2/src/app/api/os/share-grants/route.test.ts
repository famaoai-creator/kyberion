import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer: unknown, operation: () => unknown) => operation()),
  shareGrantActorFromViewer: vi.fn(() => ({
    principalId: 'principal:owner',
    authenticated: true as const,
    tenantSlugs: ['tenant-a'],
  })),
  createShareGrantRegistryAuthorizer: vi.fn(() => vi.fn()),
  projectTaint: vi.fn(() => ({
    missionId: 'mission-1',
    highestTier: 'public' as const,
    tenants: [],
    prohibitExternal: false,
    observationIds: [],
  })),
  registerResource: vi.fn(),
  grantEdge: vi.fn(),
  revokeEdge: vi.fn(),
  issueShareLink: vi.fn(),
  revokeShareLink: vi.fn(),
  openShareLinkSession: vi.fn(),
  evictShareLinkSessions: vi.fn(),
  ProvenanceTaintPolicyError: class ProvenanceTaintPolicyError extends Error {},
}));

vi.mock('@agent/core', () => ({
  CloudflareOsControlPlane: class {
    projectTaint = mocks.projectTaint;
  },
  ShareGrantAuthorizationError: class ShareGrantAuthorizationError extends Error {},
  ShareGrantValidationError: class ShareGrantValidationError extends Error {},
  ProvenanceTaintPolicyError: mocks.ProvenanceTaintPolicyError,
  ShareGrantGraph: class {
    registerResource = mocks.registerResource;
    grantEdge = mocks.grantEdge;
    revokeEdge = mocks.revokeEdge;
    issueShareLink = mocks.issueShareLink;
    revokeShareLink = mocks.revokeShareLink;
    openShareLinkSession = mocks.openShareLinkSession;
  },
  ShareGrantLiveSessionRegistry: class {
    evictShareLinkSessions = mocks.evictShareLinkSessions;
  },
  createShareGrantRegistryAuthorizer: mocks.createShareGrantRegistryAuthorizer,
  shareGrantActorFromViewer: mocks.shareGrantActorFromViewer,
}));

vi.mock('../../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));

vi.mock('../../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.resolveViewerContextForRequest,
  viewerErrorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Forbidden' },
      { status: 403 }
    ),
  withViewerExecutionContext: mocks.withViewerExecutionContext,
}));

import { POST } from './route';

describe('Chronos share-grant mutation route', () => {
  beforeEach(() => {
    mocks.guardRequest.mockReset();
    mocks.requireChronosAccess.mockReset();
    mocks.resolveViewerContextForRequest.mockReset();
    mocks.withViewerExecutionContext.mockReset();
    mocks.shareGrantActorFromViewer.mockReset();
    mocks.registerResource.mockReset();
    mocks.grantEdge.mockReset();
    mocks.revokeEdge.mockReset();
    mocks.issueShareLink.mockReset();
    mocks.revokeShareLink.mockReset();
    mocks.openShareLinkSession.mockReset();
    mocks.guardRequest.mockReturnValue(null);
    mocks.requireChronosAccess.mockReturnValue(null);
    mocks.resolveViewerContextForRequest.mockReturnValue({
      context: {
        role: 'localadmin',
        source: 'token',
        principalId: 'chronos-tenant-a',
        tenantSlugs: ['tenant-a'],
      },
    });
    mocks.shareGrantActorFromViewer.mockReturnValue({
      principalId: 'principal:owner',
      authenticated: true,
      tenantSlugs: ['tenant-a'],
    });
    mocks.withViewerExecutionContext.mockImplementation(
      (_viewer: unknown, operation: () => unknown) => operation()
    );
    mocks.registerResource.mockReturnValue({ resourceRef: 'artifact:one', tenantSlug: 'tenant-a' });
  });

  it('constructs the graph with the registry authorizer and binds POST to the viewer actor', async () => {
    const response = await POST(
      new Request('http://localhost/api/os/share-grants', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'register_resource',
          resourceRef: 'artifact:one',
          tenantSlug: 'tenant-a',
          taint: 'confidential',
          provenanceMissionId: 'mission-1',
        }),
        headers: { 'content-type': 'application/json' },
      }) as any
    );

    expect(response.status).toBe(200);
    expect(mocks.createShareGrantRegistryAuthorizer).toHaveBeenCalledOnce();
    expect(mocks.shareGrantActorFromViewer).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'chronos-tenant-a' })
    );
    expect(mocks.registerResource).toHaveBeenCalledWith({
      resourceRef: 'artifact:one',
      tenantSlug: 'tenant-a',
      taint: 'confidential',
      actor: expect.objectContaining({ principalId: 'principal:owner' }),
      provenanceMissionId: 'mission-1',
    });
  });

  it('requires localadmin before reaching the graph', async () => {
    mocks.requireChronosAccess.mockReturnValue(Response.json({ ok: false }, { status: 403 }));

    const response = await POST(
      new Request('http://localhost/api/os/share-grants', {
        method: 'POST',
        body: JSON.stringify({ operation: 'revoke_edge', edgeId: 'edge-1' }),
      }) as any
    );

    expect(response.status).toBe(403);
    expect(mocks.revokeEdge).not.toHaveBeenCalled();
  });

  it('requires an explicit target tenant for principal grants', async () => {
    const response = await POST(
      new Request('http://localhost/api/os/share-grants', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'grant_edge',
          resourceRef: 'artifact:one',
          grantee: 'principal:viewer',
          role: 'view',
        }),
      }) as any
    );

    expect(response.status).toBe(400);
    expect(mocks.grantEdge).not.toHaveBeenCalled();
  });

  it('binds session registration to the graph token-validation path', async () => {
    mocks.openShareLinkSession.mockReturnValue({
      sessionId: 'session-1',
      linkId: 'sl-1',
      resourceRef: 'artifact:one',
      connectedAt: '2026-08-09T00:00:00.000Z',
    });
    const response = await POST(
      new Request('http://localhost/api/os/share-grants', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'register_session',
          resourceRef: 'artifact:one',
          token: 'share-token',
          sessionId: 'session-1',
          connectedAt: '2026-08-09T00:00:00.000Z',
        }),
      }) as any
    );

    expect(response.status).toBe(200);
    expect(mocks.openShareLinkSession).toHaveBeenCalledWith({
      resourceRef: 'artifact:one',
      token: 'share-token',
      sessionId: 'session-1',
      connectedAt: '2026-08-09T00:00:00.000Z',
    });
  });

  it('maps provenance policy denials to forbidden instead of server error', async () => {
    mocks.registerResource.mockImplementation(() => {
      throw new mocks.ProvenanceTaintPolicyError('external sharing is prohibited');
    });

    const response = await POST(
      new Request('http://localhost/api/os/share-grants', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'register_resource',
          resourceRef: 'artifact:one',
          tenantSlug: 'tenant-a',
          taint: 'personal',
          provenanceMissionId: 'mission-1',
        }),
      }) as any
    );

    expect(response.status).toBe(403);
  });
});
