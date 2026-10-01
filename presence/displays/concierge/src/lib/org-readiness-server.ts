/**
 * Server side of the organization set-up list. Read-only; only an owner or
 * approver of a tenant sees its list (the same people who can invite). The
 * tenant set is the viewer's own scope, never a client parameter.
 */

import { findActiveCharter } from '@agent/core/governance/accountability-charter-registry';
import { listInvites, invitableRolesFor } from '@agent/core/organization/member-invite';
import { listMemberIds, readMemberProfile } from '@agent/core/organization/member-registry';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { resolveBindingOwner } from '@agent/core/service/service-binding-owner';
import { listServiceBindingRecords } from '@agent/core/service/service-binding-registry';
import { resolveConciergeDecidedBy } from './front-desk-member';
import { charterTenants } from './charter-server';
import { buildOrgReadiness, type OrgReadiness, type OrgReadinessInput } from './org-readiness-view';
import type { ConciergeViewerContext } from './viewer-context';

type Viewer = Pick<
  ConciergeViewerContext,
  'principalId' | 'source' | 'registrationLabel' | 'tenantSlugs' | 'memberId' | 'role'
>;

export interface OrgReadinessDeps {
  tenantStatus(tenant: string): OrgReadinessInput['tenantStatus'];
  memberCount(tenant: string): number;
  pendingInvites(tenant: string, now: Date): number;
  organizationConnections(tenant: string): number;
  charterInForce(tenant: string, now: Date): boolean;
}

const realDeps: OrgReadinessDeps = {
  tenantStatus: (tenant) => readTenantProfile(tenant)?.status ?? null,
  memberCount: (tenant) =>
    listMemberIds().filter((id) =>
      readMemberProfile(id)?.memberships.some((m) => m.tenant_slug === tenant)
    ).length,
  pendingInvites: (tenant, now) =>
    listInvites(tenant, {}, now).filter((i) => i.status === 'pending' && !i.expired).length,
  organizationConnections: (tenant) =>
    listServiceBindingRecords().filter((record) => {
      const owner = resolveBindingOwner(record);
      return owner.owner_kind === 'organization' && owner.owner_ref === tenant;
    }).length,
  charterInForce: (tenant, now) =>
    findActiveCharter({ kind: 'organization', tenant_slug: tenant }, now) !== null,
};

export function readOrgReadiness(
  viewer: Viewer,
  now: Date = new Date(),
  deps: OrgReadinessDeps = realDeps
): OrgReadiness[] {
  const out: OrgReadiness[] = [];
  for (const tenant of charterTenants(viewer)) {
    const who = resolveConciergeDecidedBy(viewer, tenant);
    if (invitableRolesFor(who?.role).length === 0) continue;
    out.push(
      buildOrgReadiness({
        tenantSlug: tenant,
        tenantStatus: deps.tenantStatus(tenant),
        memberCount: deps.memberCount(tenant),
        pendingInvites: deps.pendingInvites(tenant, now),
        organizationConnections: deps.organizationConnections(tenant),
        charterInForce: deps.charterInForce(tenant, now),
      })
    );
  }
  return out;
}
