/** Request selection narrows an authenticated viewer; registry records bind its parents. */
import type { OsKnowledgeTier } from '../cloudflare-os-control-plane.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { withExecutionContext } from '../authority.js';
import { safeReaddir } from '../secure-io.js';
import { tenantProfileDir } from '../organization/tenant-registry.js';
import { readTenantProfile } from '../organization/tenant-registry.js';
import { loadProjectRecord, type ProjectRecord } from '../project/project-registry.js';
import { loadOrganizationOperationalState } from '../organization/organization-operating-model-persistence.js';
import { loadOrganizationOperation } from '../organization/organization-operating-model-operations.js';
import type {
  OrganizationOperationRecord,
  OrganizationOperationalState,
} from '../organization/organization-operating-model.js';
import { narrowSurfaceViewerScope } from './surface-mutation-guard.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';

export type WorkspaceSelection = {
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  operation_id?: string;
  tier?: OsKnowledgeTier;
};
export type ResolvedWorkspaceSelection = WorkspaceSelection & {
  kind: 'tenant' | 'organization' | 'project' | 'operation';
};
export type WorkspaceViewer = Pick<
  SurfaceViewerScope,
  'tenantSlugs' | 'organizationIds' | 'projectIds' | 'tierAccess'
>;
type RegistryScope = { tier: OsKnowledgeTier; tenantSlug?: string };
export interface WorkspaceScopeDependencies {
  readTenant: (slug: string) => { tenant_slug: string } | null;
  readOrganization: (
    id: string,
    query: RegistryScope
  ) => Pick<OrganizationOperationalState, 'organization_id' | 'tenant_slug' | 'tier'> | null;
  readProject: (
    id: string
  ) => Pick<ProjectRecord, 'project_id' | 'tenant_slug' | 'organization_id' | 'tier'> | null;
  readOperation: (
    id: string,
    query: RegistryScope & { organizationId: string }
  ) => OrganizationOperationRecord | null;
}
export type ResolvedWorkspaceScope = Pick<
  WorkspaceViewer,
  'tenantSlugs' | 'organizationIds' | 'projectIds' | 'tierAccess'
> & {
  selection: ResolvedWorkspaceSelection;
  operation?: OrganizationOperationRecord;
};
export class WorkspaceScopeError extends Error {
  readonly status = 403;
  constructor() {
    super(
      '[WORKSPACE_SCOPE_UNAVAILABLE] Select an authorized tenant and matching organization, project or operation.'
    );
  }
}
const defaults: WorkspaceScopeDependencies = {
  // Registry membership is infrastructure metadata, not a personal-tier grant
  // to the viewer. Enter only after the requested tenant passed viewer narrowing.
  readTenant: (slug) =>
    withExecutionContext(
      'workspace_tenant_registry_reader',
      () => {
        const profile = readTenantProfile(slug);
        return profile ? { tenant_slug: profile.tenant_slug } : null;
      },
      'worker',
      slug
    ),
  readOrganization: loadOrganizationOperationalState,
  readProject: loadProjectRecord,
  readOperation: loadOrganizationOperation,
};

/** Safe selector projection. Bounded viewers never enumerate the registry. */
export function listWorkspaceTenantOptions(
  viewer: WorkspaceViewer
): { slug: string; displayName: string }[] {
  const candidates =
    viewer.tenantSlugs === 'all'
      ? withExecutionContext(
          'workspace_tenant_registry_index_reader',
          () =>
            safeReaddir(tenantProfileDir())
              .filter((name) => name.endsWith('.json'))
              .map((name) => name.slice(0, -5)),
          'worker'
        )
      : viewer.tenantSlugs;
  return [...new Set(candidates)]
    .filter(isValidTenantSlug)
    .flatMap((slug) => {
      try {
        // Checks exact registration with the same authenticated narrowing rules.
        resolveWorkspaceScope(viewer, { tenant_slug: slug });
        return [{ slug, displayName: slug }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
}
const fields = new Set(['tenant_slug', 'organization_id', 'project_id', 'operation_id', 'tier']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sole = (values: string[] | 'all') =>
  values !== 'all' && values.length === 1 ? values[0] : undefined;
function deny(): never {
  throw new WorkspaceScopeError();
}

export function resolveWorkspaceScope(
  viewer: WorkspaceViewer,
  requested: WorkspaceSelection,
  dependencies: WorkspaceScopeDependencies = defaults
): ResolvedWorkspaceScope {
  if (
    !requested ||
    typeof requested !== 'object' ||
    Array.isArray(requested) ||
    Object.keys(requested).some((key) => !fields.has(key))
  )
    deny();
  const selected: WorkspaceSelection = {};
  for (const [key, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) deny();
    if (key === 'tier') {
      if (
        !['public', 'confidential', 'personal'].includes(value) ||
        !viewer.tierAccess.includes(value as OsKnowledgeTier)
      )
        deny();
    } else if (key === 'tenant_slug' ? !isValidTenantSlug(value) : !idPattern.test(value)) deny();
    Object.assign(selected, { [key]: value });
  }
  if (selected.operation_id && selected.project_id) deny();
  if (selected.operation_id && viewer.projectIds !== 'all') deny();
  // Reject known unauthorized ids before inspecting any corresponding record.
  const narrow = () => {
    try {
      return narrowSurfaceViewerScope(viewer, {
        tenant: selected.tenant_slug,
        organizationId: selected.organization_id,
        projectId: selected.project_id,
      });
    } catch {
      return deny();
    }
  };
  let narrowed = narrow();
  if (selected.project_id) {
    const project = dependencies.readProject(selected.project_id);
    if (
      !project ||
      project.project_id !== selected.project_id ||
      (project.tier === 'confidential' && !project.tenant_slug) ||
      (selected.tenant_slug && selected.tenant_slug !== project.tenant_slug) ||
      (selected.organization_id && selected.organization_id !== project.organization_id) ||
      (selected.tier && selected.tier !== project.tier)
    )
      deny();
    selected.tenant_slug = project.tenant_slug;
    selected.organization_id = project.organization_id;
    selected.tier = project.tier;
  }
  if (selected.organization_id || selected.operation_id) {
    selected.tier ??= 'confidential';
    if (!selected.project_id && selected.tier === 'confidential')
      selected.tenant_slug ??= sole(viewer.tenantSlugs);
    if (selected.operation_id) selected.organization_id ??= sole(viewer.organizationIds);
    if (!selected.organization_id || (selected.tier === 'confidential' && !selected.tenant_slug))
      deny();
  }
  if (selected.tier && !viewer.tierAccess.includes(selected.tier)) deny();
  narrowed = narrow();
  if (
    (selected.project_id || selected.organization_id) &&
    ((narrowed.tenantSlugs !== 'all' && !selected.tenant_slug) ||
      (narrowed.organizationIds !== 'all' && !selected.organization_id))
  )
    deny();
  if (selected.tenant_slug) {
    if (
      !isValidTenantSlug(selected.tenant_slug) ||
      dependencies.readTenant(selected.tenant_slug)?.tenant_slug !== selected.tenant_slug
    )
      deny();
  }
  if (selected.organization_id) {
    const organization = dependencies.readOrganization(selected.organization_id, {
      tier: selected.tier!,
      tenantSlug: selected.tenant_slug,
    });
    if (
      !organization ||
      organization.organization_id !== selected.organization_id ||
      organization.tenant_slug !== selected.tenant_slug ||
      organization.tier !== selected.tier
    )
      deny();
  }
  let operation: OrganizationOperationRecord | undefined;
  if (selected.operation_id) {
    operation =
      dependencies.readOperation(selected.operation_id, {
        organizationId: selected.organization_id!,
        tenantSlug: selected.tenant_slug,
        tier: selected.tier!,
      }) ?? undefined;
    if (
      !operation ||
      operation.operation_id !== selected.operation_id ||
      operation.organization_id !== selected.organization_id ||
      operation.tenant_slug !== selected.tenant_slug ||
      operation.tier !== selected.tier
    )
      deny();
  }
  return {
    ...narrowed,
    tierAccess: selected.tier ? [selected.tier] : [...viewer.tierAccess],
    selection: {
      ...selected,
      kind: selected.operation_id
        ? 'operation'
        : selected.project_id
          ? 'project'
          : selected.organization_id
            ? 'organization'
            : 'tenant',
    },
    ...(operation ? { operation } : {}),
  };
}

/** Filter an already loaded resource; missing bindings never satisfy restrictions. */
export function workspaceScopeMatchesResource(
  workspace: ResolvedWorkspaceScope,
  resource: WorkspaceSelection
): boolean {
  if (!resource.tier || !workspace.tierAccess.includes(resource.tier)) return false;
  if (workspace.selection.tier && resource.tier !== workspace.selection.tier) return false;
  for (const [allowed, value] of [
    [workspace.tenantSlugs, resource.tenant_slug],
    [workspace.organizationIds, resource.organization_id],
    [workspace.projectIds, resource.project_id],
  ] as const) {
    if (allowed !== 'all' && (!value || !allowed.includes(value))) return false;
  }
  return (
    !workspace.selection.operation_id || resource.operation_id === workspace.selection.operation_id
  );
}
