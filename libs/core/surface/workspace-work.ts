import type { WorkItem } from '../workforce/work-coordination-types.js';
import { loadProjectRecord } from '../project/project-registry.js';
import { loadMissionStateIncludingArchive } from '../mission/mission-state.js';
import { loadOrganizationOperationalState } from '../organization/organization-operating-model-persistence.js';
import type { ResolvedWorkspaceScope, WorkspaceSelection } from './workspace-scope.js';
import { workspaceScopeMatchesResource } from './workspace-scope.js';
import { findDotCharter, type DotCharter } from '../dot/dot-charter.js';
import { currentDotActions } from '../dot/dot-action-ledger.js';
import { dotAdmissionScopeHash, dotAdmissionItemId } from '../dot/dot-admission-identity.js';

type Owner = WorkspaceSelection;
export interface WorkspaceWorkReaders {
  dot?: (id: string) => Pick<DotCharter, 'dot_id' | 'scope' | 'work_binding'> | null;
  admission?: (dotId: string, actionRef: string, itemId: string) => { scope_hash: string } | null;
  project: (id: string) => Owner | null;
  mission: (id: string, tenant?: string) => Owner | null;
  organization: (id: string, tier: NonNullable<Owner['tier']>, tenant?: string) => Owner | null;
}
const readers: WorkspaceWorkReaders = {
  dot: (id) => findDotCharter(id)?.charter ?? null,
  admission: (dotId, actionRef, itemId) => {
    const row = currentDotActions(dotId).find(
      (row) =>
        row.action_ref === actionRef &&
        (row.work_item_id === itemId || dotAdmissionItemId(actionRef) === itemId)
    );
    return row?.admission ?? null;
  },
  project: loadProjectRecord,
  mission: (id, tenantSlug) => {
    const mission = loadMissionStateIncludingArchive(id, { tenantSlug });
    return mission
      ? {
          tier: mission.tier,
          tenant_slug: mission.tenant_slug,
          organization_id:
            mission.organization_id ?? mission.relationships?.organization?.organization_id,
          project_id: mission.relationships?.project?.project_id,
        }
      : null;
  },
  organization: (id, tier, tenantSlug) =>
    loadOrganizationOperationalState(id, { tier, tenantSlug }),
};

/** WorkItem labels/top-level board ids cannot assert privacy; consult actual owners. */
export function workspaceWorkItemVisible(
  item: WorkItem,
  scope: ResolvedWorkspaceScope,
  lookup: WorkspaceWorkReaders = readers
): boolean {
  const context = item.context;
  if (!context) return false;
  const source =
    typeof item.metadata?.dot_id === 'string' ? lookup.dot?.(item.metadata.dot_id) : null;
  const admission =
    source && typeof item.metadata?.action_ref === 'string'
      ? lookup.admission?.(source.dot_id, item.metadata.action_ref, item.item_id)
      : null;
  const verifiedSource =
    source && admission?.scope_hash === dotAdmissionScopeHash(source) ? source : null;
  const operation = scope.selection.operation_id;
  if (operation) {
    if (
      !verifiedSource ||
      verifiedSource.work_binding?.operation_id !== operation ||
      item.metadata?.operation_id !== operation ||
      verifiedSource.scope.tenant_slug !== context.tenant_slug ||
      verifiedSource.scope.organization_id !== context.organization_id ||
      verifiedSource.scope.project_id !== context.project_id
    )
      return false;
  }
  const owners: Owner[] = [];
  if (context.project_id) {
    const project = lookup.project(context.project_id);
    if (!project || project.project_id !== context.project_id) return false;
    owners.push(project);
  }
  if (context.mission_id) {
    const mission = lookup.mission(context.mission_id, context.tenant_slug);
    if (!mission) return false;
    owners.push(mission);
  }
  if (!owners.length && context.organization_id) {
    // Visible tiers cannot establish the origin of an untyped organization
    // item. Require its durable admission, never choose a public namesake.
    if (
      !verifiedSource ||
      verifiedSource.scope.organization_id !== context.organization_id ||
      verifiedSource.scope.tenant_slug !== context.tenant_slug
    )
      return false;
    const organization = lookup.organization(
      context.organization_id,
      verifiedSource.scope.tier,
      context.tenant_slug
    );
    if (!organization || organization.tier !== verifiedSource.scope.tier) return false;
    owners.push(organization);
  }
  if (!owners.length) return false;
  return owners.every((owner) => {
    if (
      !owner.tier ||
      !workspaceScopeMatchesResource(scope, {
        ...owner,
        ...(operation ? { operation_id: operation } : {}),
      })
    )
      return false;
    return (['tenant_slug', 'organization_id', 'project_id'] as const).every(
      (key) => !context[key] || owner[key] === context[key]
    );
  });
}
