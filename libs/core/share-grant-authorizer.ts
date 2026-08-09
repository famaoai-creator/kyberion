import {
  ShareGrantAuthorizationError,
  type ShareGrantActor,
  type ShareGrantAuthorizer,
  type ShareGrantAuthorizationRequest,
} from './share-grant-graph.js';
import { resolveTenant, type TenantRegistryPathOptions } from './tenant-registry.js';

/**
 * Framework-neutral projection of a server-resolved viewer context.
 *
 * This deliberately mirrors the trusted fields from surface viewer contexts
 * without importing a Next.js request type into core. A principal is required
 * for mutations; an anonymous or unlabeled loopback viewer cannot be promoted
 * into a share-grant actor.
 */
export interface ShareGrantViewerContext {
  principalId?: string;
  tenantSlugs: readonly string[] | 'all';
  source: 'token' | 'loopback' | 'anonymous';
}

export interface ShareGrantTenantRecord {
  status: 'active' | 'suspended' | 'archived';
}

export interface ShareGrantTenantAuthorizerOptions {
  /** Resolve against the tenant registry; missing tenants must return null. */
  resolveTenant: (tenantSlug: string) => ShareGrantTenantRecord | null;
  /** Optional explicit broker gate for cross-tenant principal grants. */
  authorizeCrossTenant?: (request: ShareGrantAuthorizationRequest) => void;
}

export function shareGrantActorFromViewer(viewer: ShareGrantViewerContext): ShareGrantActor {
  if (viewer.source === 'anonymous') {
    throw new ShareGrantAuthorizationError('share grants require an authenticated viewer');
  }
  const principalId = viewer.principalId?.trim();
  if (!principalId) {
    throw new ShareGrantAuthorizationError(
      'share grants require a viewer context with an explicit principal'
    );
  }
  return {
    principalId,
    authenticated: true,
    tenantSlugs:
      viewer.tenantSlugs === 'all'
        ? 'all'
        : [...new Set(viewer.tenantSlugs.map((slug) => slug.trim()))],
  };
}

/**
 * Binds graph mutations to the server-resolved viewer scope and the tenant
 * registry. Tenant `all` is not a bypass: the registry still must report an
 * active tenant, and suspended/archived/missing tenants are denied.
 */
export function createShareGrantTenantAuthorizer(
  options: ShareGrantTenantAuthorizerOptions
): ShareGrantAuthorizer {
  return (request: ShareGrantAuthorizationRequest): void => {
    const tenantSlug = request.tenantSlug.trim();
    if (!tenantSlug) {
      throw new ShareGrantAuthorizationError('share grant tenant scope is required');
    }
    if (request.actor.authenticated !== true) {
      throw new ShareGrantAuthorizationError('share grants require an authenticated actor');
    }

    const tenant = options.resolveTenant(tenantSlug);
    if (!tenant || tenant.status !== 'active') {
      throw new ShareGrantAuthorizationError(
        `share grant tenant ${tenantSlug} is not an active registered tenant`
      );
    }

    const tenantSlugs = request.actor.tenantSlugs;
    if (!tenantSlugs) {
      throw new ShareGrantAuthorizationError('share grant actor tenant scope is missing');
    }
    if (tenantSlugs !== 'all' && !tenantSlugs.includes(tenantSlug)) {
      throw new ShareGrantAuthorizationError(
        `share grant tenant scope denied for ${request.actor.principalId}: ${tenantSlug}`
      );
    }

    if (request.ownerPrincipal && request.ownerPrincipal !== request.actor.principalId) {
      throw new ShareGrantAuthorizationError(
        'share grant ownerPrincipal must match the authenticated actor principal'
      );
    }

    if (request.targetPrincipal && request.operation === 'grant_edge') {
      const targetTenantSlug = request.targetTenantSlug?.trim();
      if (!targetTenantSlug) {
        throw new ShareGrantAuthorizationError(
          'grant_edge requires an explicit target tenant for the grantee'
        );
      }
      const targetTenant = options.resolveTenant(targetTenantSlug);
      if (!targetTenant || targetTenant.status !== 'active') {
        throw new ShareGrantAuthorizationError(
          `share grant target tenant ${targetTenantSlug} is not active`
        );
      }
      if (targetTenantSlug !== tenantSlug) {
        if (!options.authorizeCrossTenant) {
          throw new ShareGrantAuthorizationError(
            'cross-tenant share grants require an explicit broker authorization'
          );
        }
        options.authorizeCrossTenant(request);
      }
    }
  };
}

/** Build the authorizer against Kyberion's canonical tenant registry. */
export function createShareGrantRegistryAuthorizer(
  options: TenantRegistryPathOptions = {}
): ShareGrantAuthorizer {
  return createShareGrantTenantAuthorizer({
    resolveTenant: (tenantSlug) => {
      try {
        return resolveTenant(tenantSlug, options).profile;
      } catch {
        // Missing or invalid registry entries are authorization failures, not
        // reasons to let a mutation proceed with an assumed tenant.
        return null;
      }
    },
  });
}
