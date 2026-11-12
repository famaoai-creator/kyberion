import type { NextRequest } from 'next/server';

import { resolveConciergeInstallationAccess } from '../installation-access';
import type { ConciergeViewerContext } from '../viewer-context';
import type { ViewerContext } from './ops-viewer';

/**
 * Who may start an operation that acts on the whole repository and has no
 * tenant-aware projection (launching a catalog pipeline; registering,
 * changing, removing or running a schedule of one).
 *
 * - An all-tenant viewer: the request is not confined to a tenant.
 * - The installation owner, when what confines the viewer is the server and
 *   the owner's own memberships, not the credential: a signed-in owner
 *   (browser session / OIDC, whose tenant set is their memberships narrowed
 *   by the server binding — `KYBERION_TENANT` or the persisted
 *   `pnpm scope use` scope) owns the machine, so that set is a default view,
 *   not a boundary. Decided by the installation-owner model
 *   (`installation-owner-authorization.md`), write mode: loopback, or a
 *   recent passkey step-up from another device.
 * - A credential-less loopback request while that model admits one: first-run
 *   bootstrap still open, or the default-off
 *   `KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK` escape hatch. With an owner
 *   bound and the hatch off such a request has no viewer at all (401).
 *
 * Refused: a registry-token registration, which always carries its own
 * `tenant_slugs` — it is confined by the credential, even when it is bound to
 * the owner member; the env localadmin token on a tenant-bound server (never
 * the installation owner); every other member. The caller has already
 * required the `localadmin` role.
 */
export function opsViewerMayActRepositoryWide(viewer: ViewerContext, req: NextRequest): boolean {
  if (viewer.tenantSlugs === 'all') return true;
  // A registration's tenant list is the credential's own scope: no override.
  if (viewer.principal?.provider === 'registry-token') return false;
  const installationViewer: ConciergeViewerContext = {
    ...viewer,
    organizationIds: viewer.organizationIds ?? 'all',
    projectIds: viewer.projectIds ?? 'all',
    tierAccess: viewer.tierAccess ?? [],
  };
  return resolveConciergeInstallationAccess(installationViewer, 'write', req).allowed === true;
}

export const REPOSITORY_WIDE_REFUSAL =
  'This operation acts on the whole repository: it requires an all-tenant localadmin viewer or the installation owner; a viewer confined to a tenant cannot use it.';
