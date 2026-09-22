/**
 * surface-authn — binds HTTP surface adapters to the authn/authz seams.
 *
 * `resolveSurfaceViewerScope` (surface-mutation-guard.ts) remains the legacy
 * compatibility contract; {@link resolveAuthnSurfaceViewerScope} accepts the
 * same option shape but resolves the viewer through the
 * `authn-principal-resolver` seam — ranked, audited provider selection over
 * registry / env / agent / OIDC credentials — and projects the verified
 * principal back onto the `SurfaceViewerScope` the existing guard chain
 * consumes. Transport proof stays adapter-owned exactly as the seam
 * contract requires: the caller asserts `local` (loopback), parses the
 * bearer header, and supplies `serverTenant` from server config.
 *
 * Option → seam mapping (all preserved from the legacy resolver):
 *   token → bearer credential (none when absent; a presented token always
 *           outranks the loopback compatibility path, matching legacy)
 *   local + allowLoopback + loopbackRole → request.loopback / loopbackRole
 *   serverTenant → serverTenant, except for a credential-free loopback
 *           request when `loopbackUsesServerTenant` is unset — the legacy
 *           all-tenant loopback boundary must not be narrowed by
 *           `scopedTenants()`
 *   apiToken / localadminToken → env overlay (unset means NOT accepted —
 *           ambient KYBERION_* env tokens never authenticate a surface that
 *           did not opt into them)
 *   configuredCredentials → deps.surfaceCredentials (env-token judges them
 *           after the KYBERION_* tokens, same precedence as legacy)
 *   registrations → deps.registrations (undefined lets the provider read
 *           the registry itself)
 *   principalIds → relabels generic env/loopback principals only (a
 *           registry label or a real member/agent/OIDC identity is never
 *           overwritten)
 *   allowPersonalTier === false → masks 'personal' off the resolved tier
 *           set; a registration that explicitly requested 'personal' still
 *           fails closed like the legacy path
 *
 * {@link authorizeSurfaceContextOperation} is the authz twin: it feeds the
 * context's authenticated principal (or a synthesized one for legacy
 * callers) through `authorizeWithPolicyEngine`, so provider selection —
 * role-scope by default, member-membership / policy-file when selected —
 * is governed by the same seam machinery.
 */

import { humanActor, serviceActor } from './actor.js';
import { findChronosTokenRegistration } from './chronos-access-registry.js';
import type { OsKnowledgeTier } from './cloudflare-os-control-plane.js';
import { isValidTenantSlug } from './entity-scope.js';
import { isValidMemberId } from './member-id-grammar.js';
import {
  AuthnError,
  resolveAuthnPrincipal,
  toSurfaceViewerScope,
  type AuthnRequest,
  type AuthnResolveDeps,
  type ResolvedPrincipal,
} from './authn-principal-resolver.js';
import './authn-providers.js';
import {
  authorizeWithPolicyEngine,
  type AuthzDecision,
  type AuthzOperation,
  type AuthzResolveDeps,
  type AuthzResource,
} from './authz-policy-engine.js';
import './authz-providers.js';
import type { SeamProviderDecision } from './seam-provider-selection.js';
import {
  SurfaceViewerScopeError,
  type SurfaceViewerScope,
  type SurfaceViewerScopeResolutionOptions,
} from './surface-mutation-guard.js';
import type { SurfaceAuthorizationContext } from './surface-authorization.js';

// ---------------------------------------------------------------------------
// authn — viewer scope through the principal-resolver seam
// ---------------------------------------------------------------------------

export interface SurfaceAuthnScopeOptions extends SurfaceViewerScopeResolutionOptions {
  /** Seam purpose for provider ranking (default 'remote_human'). */
  purpose?: string;
  /** Surface label exposed to operator seam rules as `context.surface`. */
  surface?: string;
  /** Restrict the eligible authn providers for this surface. */
  providerIds?: readonly string[];
  /** Additional seam deps (jwks, memberRegistry, now, env overlay base). */
  deps?: Omit<AuthnResolveDeps, 'registrations' | 'surfaceCredentials'>;
}

export interface SurfaceAuthnScopeResolution {
  scope: SurfaceViewerScope;
  principal: ResolvedPrincipal;
  decision: SeamProviderDecision;
}

function surfaceAuthnMessage(error: AuthnError, hadCredential: boolean): string {
  // The seam's two "nobody could judge this" failures map back onto the
  // canonical legacy messages surface adapters pattern-match on; every
  // provider-authored reason (scope_denied, expired token, …) passes
  // through verbatim.
  if (
    error.message.startsWith('authentication unresolved') ||
    error.message.startsWith('no provider accepted the credential')
  ) {
    return hadCredential ? 'Unknown viewer token.' : 'A viewer principal is required.';
  }
  return error.message;
}

export function resolveAuthnSurfaceViewerScope(
  options: SurfaceAuthnScopeOptions = {}
): SurfaceAuthnScopeResolution {
  const token = options.token?.trim() || '';
  const local = options.local === true;
  const serverTenant = options.serverTenant?.trim() || undefined;
  if (serverTenant && !isValidTenantSlug(serverTenant)) {
    throw new SurfaceViewerScopeError(403, 'server tenant scope is invalid.');
  }

  const credentialFree = !token;
  const request: AuthnRequest = {
    credential: token ? { type: 'bearer', token } : { type: 'none' },
    loopback: local && options.allowLoopback === true && options.loopbackRole !== undefined,
    ...(options.loopbackRole ? { loopbackRole: options.loopbackRole } : {}),
    serverTenant: credentialFree && !options.loopbackUsesServerTenant ? undefined : serverTenant,
  };

  const envOverlay: Record<string, string | undefined> = {
    ...(options.deps?.env ?? process.env),
    KYBERION_API_TOKEN: options.apiToken ?? '',
    KYBERION_LOCALADMIN_TOKEN: options.localadminToken ?? '',
  };
  const deps: AuthnResolveDeps = {
    ...(options.deps ?? {}),
    env: envOverlay,
    registrations: options.registrations,
    surfaceCredentials: options.configuredCredentials,
  };

  let principal: ResolvedPrincipal;
  let decision: SeamProviderDecision;
  try {
    const resolution = resolveAuthnPrincipal(request, {
      purpose: options.purpose ?? 'remote_human',
      ...(options.surface ? { context: { surface: options.surface } } : {}),
      ...(options.providerIds ? { providerIds: options.providerIds } : {}),
      deps,
    });
    principal = resolution.principal;
    decision = resolution.decision;
  } catch (error) {
    if (error instanceof AuthnError) {
      throw new SurfaceViewerScopeError(error.status, surfaceAuthnMessage(error, !credentialFree));
    }
    throw error;
  }

  const scope = toSurfaceViewerScope(principal);
  if (
    (principal.provider === 'loopback-local' || principal.provider === 'env-token') &&
    options.principalIds?.[scope.role]
  ) {
    scope.principalId = options.principalIds[scope.role];
  }

  if (options.allowPersonalTier === false) {
    const registration =
      principal.provider === 'registry-token' && token && options.registrations?.length
        ? findChronosTokenRegistration(token, [...options.registrations])
        : null;
    if (registration?.tier_access?.includes('personal')) {
      throw new SurfaceViewerScopeError(
        403,
        `viewer tier scope exceeds the ${registration.role} role policy.`
      );
    }
    scope.tierAccess = scope.tierAccess.filter((tier) => tier !== 'personal');
    // The authz seam evaluates principal.tierAccess when the context carries
    // the principal — mask it in step or the personal-tier mask is defeated.
    principal.tierAccess = [...scope.tierAccess];
  }

  return { scope, principal, decision };
}

// ---------------------------------------------------------------------------
// authz — surface operations through the policy-engine seam
// ---------------------------------------------------------------------------

/**
 * Rebuild a minimal principal from a bare authorization context for callers
 * that never went through the authn seam (tests, hand-built contexts). The
 * role-scope provider only reads the claim fields; member-membership also
 * consumes `memberId` / a human actor.
 */
export function principalFromSurfaceAuthorizationContext(
  context: SurfaceAuthorizationContext
): ResolvedPrincipal {
  const memberId =
    context.memberId && isValidMemberId(context.memberId) ? context.memberId : undefined;
  return {
    actor: memberId ? humanActor(memberId) : serviceActor('surface-viewer'),
    principalId: context.principalId ?? (memberId ? `user:${memberId}` : 'surface-viewer'),
    role: context.role,
    tenantSlugs: context.tenantSlugs === 'all' ? 'all' : [...context.tenantSlugs],
    organizationIds: context.organizationIds === 'all' ? 'all' : [...context.organizationIds],
    projectIds: context.projectIds === 'all' ? 'all' : [...context.projectIds],
    tierAccess: [...context.tierAccess] as OsKnowledgeTier[],
    source: context.source ?? 'token',
    provider: 'surface-context',
    assurance: 'none',
    ...(memberId ? { memberId } : {}),
  };
}

export interface SurfaceContextOperationInput {
  context: SurfaceAuthorizationContext;
  operation: AuthzOperation;
  resource?: AuthzResource;
  /** Seam purpose (default 'default_surface' — keeps role-scope ranked first). */
  purpose?: string;
  /** Surface label for operator seam rules (`context.surface`). */
  surface?: string;
  providerIds?: readonly string[];
  deps?: AuthzResolveDeps;
}

export function authorizeSurfaceContextOperation(
  input: SurfaceContextOperationInput
): AuthzDecision {
  const principal =
    input.context.principal ?? principalFromSurfaceAuthorizationContext(input.context);
  const { authorization } = authorizeWithPolicyEngine(
    {
      principal,
      operation: input.operation,
      ...(input.resource ? { resource: input.resource } : {}),
      // FD-07: an explicit permission replacement set must survive the seam —
      // ResolvedPrincipal cannot carry it, so it travels on the query itself.
      ...(input.context.permissions ? { permissions: input.context.permissions } : {}),
    },
    {
      purpose: input.purpose ?? 'default_surface',
      ...(input.surface ? { context: { surface: input.surface } } : {}),
      ...(input.providerIds ? { providerIds: input.providerIds } : {}),
      ...(input.deps ? { deps: input.deps } : {}),
    }
  );
  return authorization;
}
