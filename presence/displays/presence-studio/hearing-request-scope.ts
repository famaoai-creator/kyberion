import type { Request } from 'express';
import { withExecutionContext } from '@agent/core/authority';
import { resolveOwnerScope } from '@agent/core/owner-scope';
import { loadProjectRecord } from '@agent/core/project/project-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { loadOrganizationOperationalState } from '@agent/core/organization/organization-operating-model';
import { hearingNamespace } from './hearing-runtime.js';
import {
  PresenceStudioViewerError,
  narrowPresenceStudioScope,
  resolvePresenceStudioViewerContext,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';

/** Selection narrows authenticated scope; malformed query values are never absence. */
export function resolveHearingRequestViewer(req: Request): PresenceStudioViewerContext {
  const resolved = resolvePresenceStudioViewerContext(req);
  const selection = (key: 'tenant' | 'organizationId' | 'projectId'): string | undefined => {
    const value = req.query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string')
      throw new PresenceStudioViewerError(403, 'Invalid hearing scope selection.');
    const selected = value.trim();
    if (key === 'tenant' && (selected === 'all' || selected === 'unscoped'))
      throw new PresenceStudioViewerError(403, 'Invalid hearing scope selection.');
    return selected || undefined;
  };
  const viewer = narrowPresenceStudioScope(resolved, {
    tenant: selection('tenant'),
    organizationId: selection('organizationId'),
    projectId: selection('projectId'),
  });
  if (viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length > 1)
    throw new PresenceStudioViewerError(403, 'Select one tenant for the hearing.');
  return viewer;
}

/** Canvas loads independently from the JSON request, so carry its validated scope. */
export function hearingScopedUrl(path: string, viewer: PresenceStudioViewerContext): string {
  const url = new URL(path, 'http://hearing.invalid');
  const scope = toFrontDeskViewerScope(viewer);
  for (const [key, values] of [
    ['tenant', scope.tenantSlugs],
    ['organizationId', scope.organizationIds],
    ['projectId', scope.projectIds],
  ] as const) {
    url.searchParams.delete(key);
    if (values !== 'all' && values.length === 1) url.searchParams.set(key, values[0]);
  }
  return url.origin === 'http://hearing.invalid' ? url.pathname + url.search + url.hash : url.href;
}

export class HearingScopeError extends Error {
  readonly status = 400 as const;
  constructor(
    readonly code: 'hearing_scope_unavailable' | 'hearing_inventory_project_unsupported'
  ) {
    super(code);
  }
}

/** Destination metadata must represent the selected hierarchy before any effect.
 * Hearing storage itself remains tenant/session-scoped, not org/project-partitioned. */
export function resolveHearingHandoffScope(
  viewer: PresenceStudioViewerContext,
  kind: 'mission' | 'inventory'
): { tenantSlug?: string; organizationId?: string; projectId?: string } {
  const allowed = toFrontDeskViewerScope(viewer);
  if (kind === 'inventory' && allowed.projectIds !== 'all')
    throw new HearingScopeError('hearing_inventory_project_unsupported');
  const single = (values: string[] | 'all'): string | undefined => {
    if (values === 'all') return undefined;
    if (values.length !== 1) throw new HearingScopeError('hearing_scope_unavailable');
    return values[0];
  };
  let organizationId = single(allowed.organizationIds);
  const projectId = single(allowed.projectIds);
  if (viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length > 1)
    throw new HearingScopeError('hearing_scope_unavailable');
  const namespace = hearingNamespace(viewer.tenantSlugs);
  if (namespace === 'all' || namespace === 'unscoped') {
    if (kind === 'mission' || organizationId || projectId || viewer.source !== 'loopback')
      throw new HearingScopeError('hearing_scope_unavailable');
    return {};
  }
  try {
    return withExecutionContext(
      'ecosystem_architect',
      () => {
        if (projectId) {
          const project = resolveOwnerScope(
            { kind: 'project', id: projectId },
            { tier: 'confidential', tenant: namespace }
          );
          if (
            project.project_id !== projectId ||
            project.tier !== 'confidential' ||
            project.tenant !== namespace ||
            !project.organization_id ||
            (organizationId && organizationId !== project.organization_id)
          )
            throw new HearingScopeError('hearing_scope_unavailable');
          organizationId = project.organization_id;
          // The project may supply an omitted parent, but never an unauthorized one.
          narrowPresenceStudioScope(viewer, { organizationId, projectId });
          // The governed controller requires a scaffold before linking a project.
          // Discover this deterministic pre-write rejection before reserving the hearing.
          const registered = loadProjectRecord(projectId);
          if (
            !registered ||
            registered.project_id !== projectId ||
            registered.tenant_slug !== namespace ||
            registered.tier !== 'confidential' ||
            registered.organization_id !== organizationId
          )
            throw new HearingScopeError('hearing_scope_unavailable');
          const projectOs = assertSafeRepositoryPath(
            pathResolver.rootResolve(
              registered.project_os_path ||
                pathResolver.projectOsDir(projectId, project.tier, project.tenant)
            ),
            { allowMissingLeaf: true }
          );
          if (!safeExistsSync(projectOs) || !safeLstat(projectOs).isDirectory())
            throw new HearingScopeError('hearing_scope_unavailable');
        }
        if (organizationId) {
          const organization = loadOrganizationOperationalState(organizationId, {
            tier: 'confidential',
            tenantSlug: namespace,
          });
          if (
            !organization ||
            organization.organization_id !== organizationId ||
            organization.tier !== 'confidential' ||
            organization.tenant_slug !== namespace
          )
            throw new HearingScopeError('hearing_scope_unavailable');
        }
        return {
          tenantSlug: namespace,
          ...(organizationId ? { organizationId } : {}),
          ...(projectId ? { projectId } : {}),
        };
      },
      undefined,
      namespace
    );
  } catch {
    // Do not disclose whether a foreign, missing, corrupt, or inconsistent owner exists.
    throw new HearingScopeError('hearing_scope_unavailable');
  }
}
