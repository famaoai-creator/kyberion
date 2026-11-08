import { withExecutionContext } from '../authority.js';
import { resolveOwnerScope } from '../governance/owner-scope.js';
import { loadProjectRecord } from '../project/project-registry.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import { loadOrganizationOperationalState } from '../organization/organization-operating-model.js';
import { hearingNamespace } from './hearing-runtime.js';
import { narrowSurfaceViewerScope } from './surface-mutation-guard.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';

/**
 * The owner decision every hearing function that reaches the personal store
 * takes as an explicit input: `true` only when the surface itself decided that
 * this request comes from the owner of this machine. Each surface decides it
 * with its own check — Studio: the credential-free loopback session
 * (`viewer.source === 'loopback'`); Concierge: `resolveConciergeInstallationAccess`
 * (the bound installation owner on an attested peer, or with step-up). Never
 * derive it from the viewer's credential `source` here, and never synthesize a
 * `source: 'loopback'` viewer to obtain it
 * (kyberion-development-practices.md, "The local owner is not the credential source").
 */
export interface HearingOwnerInput {
  owner: boolean;
}

/** Canvas loads independently from the JSON request, so carry its validated scope.
 * Used by: Studio, Concierge. */
export function hearingScopedUrl(
  path: string,
  scope: Pick<SurfaceViewerScope, 'tenantSlugs' | 'organizationIds' | 'projectIds'>
): string {
  const url = new URL(path, 'http://hearing.invalid');
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

/** Used by: Studio and Concierge (route error mapping). */
export class HearingScopeError extends Error {
  readonly status = 400 as const;
  constructor(
    readonly code: 'hearing_scope_unavailable' | 'hearing_inventory_project_unsupported'
  ) {
    super(code);
  }
}

/** Destination metadata must represent the selected hierarchy before any effect.
 * Hearing storage itself remains tenant/session-scoped, not org/project-partitioned.
 * `viewer` is the surface's server-resolved, already narrowed viewer scope.
 * Only the owner ({@link HearingOwnerInput}) may file an inventory entry under the
 * personal scope (no single tenant). Used by: Studio, Concierge.
 */
export function resolveHearingHandoffScope(
  viewer: SurfaceViewerScope,
  kind: 'mission' | 'inventory',
  options: HearingOwnerInput
): { tenantSlug?: string; organizationId?: string; projectId?: string } {
  const allowed = viewer;
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
    if (kind === 'mission' || organizationId || projectId || options.owner !== true)
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
          narrowSurfaceViewerScope(allowed, { organizationId, projectId });
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
