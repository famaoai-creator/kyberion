import { describe, expect, it } from 'vitest';
import {
  createShareGrantTenantAuthorizer,
  shareGrantActorFromViewer,
} from './share-grant-authorizer.js';
import { ShareGrantAuthorizationError, ShareGrantGraph } from './share-grant-graph.js';

const HMAC_KEY = 'os13-share-authorizer-test-key-123456';

function viewer(
  principalId: string | undefined,
  tenantSlugs: readonly string[] | 'all' = ['tenant-a']
): Parameters<typeof shareGrantActorFromViewer>[0] {
  return { principalId, tenantSlugs, source: 'token' };
}

function graphForViewer(
  currentViewer: Parameters<typeof shareGrantActorFromViewer>[0],
  tenants: Record<string, 'active' | 'suspended' | 'archived'> = {
    'tenant-a': 'active',
    'tenant-b': 'active',
  }
) {
  const actor = shareGrantActorFromViewer(currentViewer);
  const graph = new ShareGrantGraph({
    persist: false,
    hmacKey: HMAC_KEY,
    authorizeActor: createShareGrantTenantAuthorizer({
      resolveTenant: (tenantSlug) => {
        const status = tenants[tenantSlug];
        return status ? { status } : null;
      },
    }),
    resolveTenant: (tenantSlug) => {
      const status = tenants[tenantSlug];
      return status ? { status } : null;
    },
  });
  return { actor, graph };
}

describe('ShareGrant tenant authorizer', () => {
  it('projects a labeled server viewer into an authenticated actor', () => {
    expect(shareGrantActorFromViewer(viewer('principal:owner'))).toEqual({
      principalId: 'principal:owner',
      authenticated: true,
      tenantSlugs: ['tenant-a'],
    });
  });

  it('rejects anonymous or unlabeled viewers before graph mutation', () => {
    expect(() =>
      shareGrantActorFromViewer({
        principalId: 'principal:owner',
        tenantSlugs: ['tenant-a'],
        source: 'anonymous',
      })
    ).toThrow(ShareGrantAuthorizationError);
    expect(() => shareGrantActorFromViewer(viewer(undefined))).toThrow(
      ShareGrantAuthorizationError
    );
  });

  it('allows a viewer only inside the active tenant scope', () => {
    const { actor, graph } = graphForViewer(viewer('principal:owner'));
    graph.registerResource({
      resourceRef: 'artifact:tenant-a',
      tenantSlug: 'tenant-a',
      taint: 'confidential',
      actor,
    });

    expect(() =>
      graph.registerResource({
        resourceRef: 'artifact:tenant-b',
        tenantSlug: 'tenant-b',
        taint: 'public',
        actor,
      })
    ).toThrow(ShareGrantAuthorizationError);
  });

  it('does not let all-tenant scope bypass the tenant registry status', () => {
    const { actor, graph } = graphForViewer(viewer('principal:owner', 'all'), {
      'tenant-a': 'suspended',
    });
    expect(() =>
      graph.registerResource({
        resourceRef: 'artifact:suspended',
        tenantSlug: 'tenant-a',
        taint: 'public',
        actor,
      })
    ).toThrow(ShareGrantAuthorizationError);
  });

  it('keeps resource tenant binding on every mutation', () => {
    const { actor, graph } = graphForViewer(viewer('principal:owner'));
    graph.registerResource({
      resourceRef: 'artifact:bound',
      tenantSlug: 'tenant-a',
      taint: 'public',
      actor,
    });
    expect(graph.getResource('artifact:bound')).toMatchObject({ tenantSlug: 'tenant-a' });
    expect(() =>
      graph.grantEdge({
        resourceRef: 'artifact:bound',
        actor: { ...actor, tenantSlugs: ['tenant-b'] },
        grantee: 'principal:viewer',
        role: 'view',
      })
    ).toThrow(ShareGrantAuthorizationError);
  });

  it('denies cross-tenant principal grants without an explicit broker gate', () => {
    const { actor, graph } = graphForViewer(viewer('principal:owner'));
    graph.registerResource({
      resourceRef: 'artifact:cross-tenant',
      tenantSlug: 'tenant-a',
      taint: 'confidential',
      actor,
    });

    expect(() =>
      graph.grantEdge({
        resourceRef: 'artifact:cross-tenant',
        actor,
        grantee: 'principal:tenant-b-viewer',
        targetTenantSlug: 'tenant-b',
        role: 'view',
      })
    ).toThrow(ShareGrantAuthorizationError);
  });

  it('re-resolves observation provenance before grants and external links', () => {
    const actor = shareGrantActorFromViewer(viewer('principal:owner'));
    const resolveTenant = (tenantSlug: string) =>
      tenantSlug === 'tenant-a' ? { status: 'active' as const } : null;
    const graph = new ShareGrantGraph({
      persist: false,
      hmacKey: HMAC_KEY,
      resolveTenant,
      resolveProvenance: () => ({
        missionId: 'mission-1',
        highestTier: 'personal',
        tenants: ['tenant-a'],
        prohibitExternal: true,
        observationIds: ['observation-1'],
      }),
      authorizeActor: createShareGrantTenantAuthorizer({
        resolveTenant,
      }),
    });
    graph.registerResource({
      resourceRef: 'artifact:provenance',
      tenantSlug: 'tenant-a',
      taint: 'public',
      provenanceMissionId: 'mission-1',
      actor,
    });

    expect(graph.getResource('artifact:provenance')).toMatchObject({ taint: 'personal' });
    expect(() =>
      graph.grantEdge({
        resourceRef: 'artifact:provenance',
        actor,
        grantee: 'principal:viewer',
        targetTenantSlug: 'tenant-a',
        role: 'view',
        audienceFloor: 'confidential',
      })
    ).toThrow('broaden personal taint');
    expect(() =>
      graph.issueShareLink({
        resourceRef: 'artifact:provenance',
        actor,
        role: 'view',
      })
    ).toThrow('external sharing');
  });

  it('invalidates a previously issued link when provenance becomes non-public', () => {
    const actor = shareGrantActorFromViewer(viewer('principal:owner'));
    let provenance = {
      missionId: 'mission-1',
      highestTier: 'public' as const,
      tenants: ['tenant-a'],
      prohibitExternal: false,
      observationIds: [],
    };
    const resolveTenant = (tenantSlug: string) =>
      tenantSlug === 'tenant-a' ? { status: 'active' as const } : null;
    const graph = new ShareGrantGraph({
      persist: false,
      hmacKey: HMAC_KEY,
      resolveTenant,
      resolveProvenance: () => provenance,
      authorizeActor: createShareGrantTenantAuthorizer({ resolveTenant }),
    });
    graph.registerResource({
      resourceRef: 'artifact:dynamic-link',
      tenantSlug: 'tenant-a',
      taint: 'public',
      provenanceMissionId: 'mission-1',
      actor,
    });
    const link = graph.issueShareLink({
      resourceRef: 'artifact:dynamic-link',
      actor,
      role: 'view',
    });
    expect(graph.resolveShareLink('artifact:dynamic-link', link.token)).toMatchObject({
      role: 'view',
    });

    provenance = {
      ...provenance,
      highestTier: 'personal',
      prohibitExternal: true,
      observationIds: ['observation-1'],
    };
    expect(graph.resolveShareLink('artifact:dynamic-link', link.token)).toBeNull();
  });
});
