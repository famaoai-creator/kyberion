/**
 * FD-01: pure `GET /api/me` payload builder shared by both front-desk
 * surfaces (companion + concierge). `buildFrontDeskMe` performs no I/O — it
 * only combines a server-resolved viewer scope with caller-loaded tenant
 * profiles. `readFrontDeskMe` is the thin I/O wrapper around it.
 *
 * Local role/type copies on purpose: FD-00a defines the same `FrontDeskRole`
 * union in the shared nav module, which a sibling task is authoring
 * concurrently. Duplicating the tiny union here avoids a cross-task import
 * race; a follow-up can consolidate once both land.
 */

import { getRegisteredEnvText } from './foundation/env.js';
import { currentScope } from './scope-context.js';
import { resolveOperatorDisplayName } from './operator-identity.js';
import {
  listTenantProfileSlugs,
  readTenantProfile,
  type TenantProfile,
  type TenantRegistryPathOptions,
} from './tenant-registry.js';
import { resolveMemberByPrincipal, type MemberRegistryPathOptions } from './member-registry.js';
import { narrowSurfaceViewerTenant, type SurfaceViewerScope } from './surface-mutation-guard.js';

/** Human-facing role union (plan §2.3). `approver` arrives with FD-07. */
export type FrontDeskRole = 'owner' | 'approver' | 'viewer';

/**
 * FD-07: a member resolved by `resolveMemberByPrincipal`, projected to the
 * fields `buildFrontDeskMe` needs. Kept local (rather than importing
 * `MemberProfile` wholesale) so this pure function only depends on the shape
 * it actually reads.
 */
export interface FrontDeskResolvedMember {
  member_id: string;
  display_name: string;
  memberships: ReadonlyArray<{ tenant_slug: string; role: FrontDeskRole }>;
}

export interface FrontDeskTenantView {
  tenant_slug: string;
  display_name: string;
  role: FrontDeskRole;
  status: 'active' | 'suspended' | 'archived';
  assigned_role?: string;
}

export interface FrontDeskMe {
  ok: true;
  member: {
    member_id: string;
    display_name: string;
    source: 'loopback' | 'token' | 'anonymous';
    /** FD-07: true once this principal resolves to a knowledge/personal/members/ record. */
    registered: boolean;
  };
  /** The tenant currently displayed (narrowed selection), or null when the viewer has none. */
  viewing: FrontDeskTenantView | null;
  /** Every tenant the viewer may see, sorted by display_name (ja-insensitive). */
  tenants: FrontDeskTenantView[];
  /** Server-side write tenant (KYBERION_TENANT / currentScope().tenant_slug); never changed by the client. */
  write_tenant: string | null;
  /** True only when the viewer may see more than one tenant. */
  can_switch: boolean;
  available_operations: string[];
  onboarded: boolean;
}

export interface BuildFrontDeskMeInput {
  /** Server-resolved; trusted. */
  scope: SurfaceViewerScope;
  /** Client-supplied; may only narrow. Outside the scope (or invalid) is ignored, never widened. */
  requestedTenant?: string | null;
  availableOperations: readonly string[];
  onboarded: boolean;
  /** Caller-resolved (loopback → operator display name; else registration label / principalId). */
  displayName?: string | null;
  writeTenant?: string | null;
  /** Caller-loaded tenant profiles. This function performs no I/O. */
  tenantProfiles: readonly TenantProfile[];
  /** FD-07: caller-resolved member (resolveMemberByPrincipal). null/absent = unregistered principal, legacy behavior. */
  member?: FrontDeskResolvedMember | null;
}

/**
 * localadmin -> owner, readonly -> viewer. `memberRole`, when given, wins
 * outright — this is the only way `approver` is ever produced (FD-07).
 */
export function frontDeskRoleFromViewerScope(
  scope: Pick<SurfaceViewerScope, 'role'>,
  memberRole?: FrontDeskRole | null
): FrontDeskRole {
  if (memberRole) return memberRole;
  return scope.role === 'localadmin' ? 'owner' : 'viewer';
}

function toTenantView(profile: TenantProfile, role: FrontDeskRole): FrontDeskTenantView {
  return {
    tenant_slug: profile.tenant_slug,
    display_name: profile.display_name,
    role,
    status: profile.status,
    assigned_role: profile.assigned_role,
  };
}

function resolveViewing(
  scope: Pick<SurfaceViewerScope, 'tenantSlugs'>,
  tenants: readonly FrontDeskTenantView[],
  requestedTenant: string | null | undefined,
  writeTenant: string | null
): FrontDeskTenantView | null {
  const requested = requestedTenant?.trim();
  if (requested) {
    try {
      const narrowed = narrowSurfaceViewerTenant(scope, requested);
      if (narrowed !== 'all') {
        const match = tenants.find((tenant) => tenant.tenant_slug === narrowed[0]);
        if (match) return match;
      }
    } catch {
      // requestedTenant is outside the viewer scope (or invalid): ignore it,
      // never widen, and fall back to the write tenant / first active tenant.
    }
  }
  if (writeTenant) {
    const match = tenants.find((tenant) => tenant.tenant_slug === writeTenant);
    if (match && match.status !== 'archived') return match;
  }
  return tenants.find((tenant) => tenant.status !== 'archived') ?? null;
}

/** Pure: combines a trusted viewer scope with caller-loaded tenant profiles. No I/O. */
export function buildFrontDeskMe(input: BuildFrontDeskMeInput): FrontDeskMe {
  const { scope, tenantProfiles, availableOperations, onboarded, member } = input;
  const legacyRole = frontDeskRoleFromViewerScope(scope);
  const isLoopback = scope.source === 'loopback';
  const allowedSlugs = scope.tenantSlugs === 'all' ? null : new Set(scope.tenantSlugs);

  // FD-07: once a member is resolved, each tenant's role comes from that
  // member's own memberships, not from the viewer's blanket scope role. A
  // token viewer sees only the tenants they hold a membership for; loopback
  // (the owner) keeps seeing every scope-allowed tenant even for one it has
  // no explicit membership row for yet (e.g. a tenant created after
  // ensureOwnerMember last ran).
  const tenants = tenantProfiles
    .filter((profile) => allowedSlugs === null || allowedSlugs.has(profile.tenant_slug))
    .map((profile) => {
      const membership = member?.memberships.find((m) => m.tenant_slug === profile.tenant_slug);
      if (membership) return toTenantView(profile, membership.role);
      if (member && !isLoopback) return null;
      return toTenantView(profile, legacyRole);
    })
    .filter((view): view is FrontDeskTenantView => view !== null)
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'));

  const writeTenant = input.writeTenant?.trim() || null;
  const viewing = resolveViewing(scope, tenants, input.requestedTenant, writeTenant);

  const principalId = scope.principalId?.trim() || undefined;
  const displayName = input.displayName?.trim() || undefined;

  return {
    ok: true,
    member: {
      member_id: member?.member_id || principalId || 'anonymous',
      display_name: member?.display_name || displayName || principalId || 'anonymous',
      source: scope.source,
      registered: Boolean(member),
    },
    viewing,
    tenants,
    write_tenant: writeTenant,
    can_switch: tenants.length > 1,
    available_operations: [...availableOperations],
    onboarded,
  };
}

export interface ReadFrontDeskMeOptions {
  requestedTenant?: string | null;
  availableOperations: readonly string[];
  onboarded: boolean;
  tenantRegistry?: TenantRegistryPathOptions;
  /** FD-07: defaults to tenantRegistry's rootDir/env — separate seam kept for callers that ever need to diverge. */
  memberRegistry?: MemberRegistryPathOptions;
}

/**
 * Thin I/O wrapper: loads tenant profiles via tenant-registry, resolves the
 * member via member-registry's `resolveMemberByPrincipal` (FD-07), display
 * name via operator-identity for an unregistered loopback viewer (else
 * registration label / principalId, already carried by `scope.principalId`),
 * write tenant from KYBERION_TENANT / currentScope(), then delegates to
 * buildFrontDeskMe.
 *
 * Tenant/member profiles live under the personal tier: the caller must
 * already be running inside an authorized execution context
 * (withExecutionContext) — this function does not establish one itself.
 */
export function readFrontDeskMe(
  scope: SurfaceViewerScope,
  options: ReadFrontDeskMeOptions
): FrontDeskMe {
  const registryOptions = options.tenantRegistry ?? {};
  const memberRegistryOptions = options.memberRegistry ?? registryOptions;
  const tenantProfiles = listTenantProfileSlugs(registryOptions)
    .map((slug) => readTenantProfile(slug, registryOptions))
    .filter((profile): profile is TenantProfile => profile !== null);

  let resolvedMember;
  try {
    resolvedMember = resolveMemberByPrincipal(
      {
        principalId: scope.principalId,
        source: scope.source,
        registrationLabel: scope.registrationLabel,
      },
      memberRegistryOptions
    );
  } catch {
    // A corrupt/unreadable member profile must never break /api/me — fall
    // back to the pre-FD-07 unregistered-principal behavior.
    resolvedMember = null;
  }

  const member: FrontDeskResolvedMember | null = resolvedMember
    ? {
        member_id: resolvedMember.member_id,
        display_name: resolvedMember.display_name,
        memberships: resolvedMember.memberships,
      }
    : null;

  const displayName =
    !resolvedMember && scope.source === 'loopback'
      ? resolveOperatorDisplayName(scope.principalId || 'sovereign-user')
      : undefined;

  const writeTenant =
    getRegisteredEnvText('KYBERION_TENANT', { env: registryOptions.env }) ||
    currentScope().tenant_slug ||
    null;

  return buildFrontDeskMe({
    scope,
    requestedTenant: options.requestedTenant,
    availableOperations: options.availableOperations,
    onboarded: options.onboarded,
    displayName,
    writeTenant,
    tenantProfiles,
    member,
  });
}
