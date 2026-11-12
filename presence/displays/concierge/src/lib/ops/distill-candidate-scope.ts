import { withExecutionContext } from '@agent/core/authority';
import { listTenants } from '@agent/core/organization/tenant-governance';
import { loadProjectRecord } from '@agent/core/project/project-registry';
import { loadState } from '@agent/core/mission/mission-state';
import {
  listDistillCandidateRecords,
  listDistillCandidateRecordsForTenants,
  type DistillCandidateRecord,
} from '@agent/core/knowledge/distill-candidate-registry';
import type { MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
import {
  listMemoryPromotionCandidates,
  type MemoryCandidate,
} from '@agent/core/knowledge/memory-promotion-queue';
import {
  projectAnyFacadeProposal,
  type FacadeProposalRecord,
} from '@agent/core/knowledge/facade-proposal-rows';
import { memoryCandidateVisibleToViewer } from './knowledge-scope';
import { admitsScopeAudience, viewerPersonIds } from '@agent/core/surface/surface-authorization';
import {
  viewerCanReadTier,
  withOpsViewerDefaults,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  type ViewerContext,
} from './ops-viewer';

function legacyScope(candidate: DistillCandidateRecord): MemoryScopeEnvelope {
  const tier = candidate.tier ?? 'confidential';
  try {
    if (candidate.project_id) {
      const project = loadProjectRecord(candidate.project_id);
      if (project)
        return {
          tier,
          tenant_slug: project.tenant_slug,
          organization_id: project.organization_id,
          project_id: project.project_id,
        };
    }
    if (candidate.mission_id) {
      const mission = loadState(candidate.mission_id);
      if (mission)
        return {
          tier,
          tenant_slug: mission.tenant_slug || mission.tenant_id,
          organization_id:
            mission.organization_id || mission.relationships?.organization?.organization_id,
          project_id: mission.relationships?.project?.project_id,
        };
    }
  } catch {
    /* Hidden or ambiguous source is not authority. */
  }
  return { tier };
}

export function distillCandidateVisibleToViewer(
  candidate: DistillCandidateRecord,
  viewer: ViewerContext,
  requestedTenant?: string
): boolean {
  const tenants = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  const organizations = strictViewerScopeOrganizationIds(viewer);
  const projects = strictViewerScopeProjectIds(viewer);
  const scope = candidate.scope ?? legacyScope(candidate);
  if (!viewerCanReadTier(viewer, scope.tier)) return false;
  if (requestedTenant && scope.tenant_slug !== requestedTenant) return false;
  const tiers = withOpsViewerDefaults(viewer).tierAccess;
  if (scope.tier === 'personal' || !tiers.includes(scope.tier)) return false;
  if (candidate.tier && candidate.tier !== scope.tier) return false;
  // Custody admission plus the record's own audience grant: person custody
  // stays identity-bound for every viewer, 'all' included; a listed audience
  // member is admitted by identity — never by scope.
  if (
    !admitsScopeAudience(
      {
        tenantSlugs: tenants,
        includeUntenanted: viewer.includeUntenanted,
        personIds: viewerPersonIds(viewer),
      },
      scope
    )
  )
    return false;
  if (
    organizations !== 'all' &&
    (!scope.organization_id || !organizations.includes(scope.organization_id))
  )
    return false;
  if (projects !== 'all' && (!scope.project_id || !projects.includes(scope.project_id)))
    return false;
  const principals = viewerPersonIds(viewer);
  const audience = scope.allowed_audience ?? [];
  const audienceMatch = audience.some((id) => principals.includes(id));
  if (audience.length && !audienceMatch) return false;
  if (scope.owner_nhi && !principals.includes(scope.owner_nhi) && !audienceMatch) return false;
  return true;
}

export function listDistillCandidatesForViewer(
  viewer: ViewerContext,
  requestedTenant?: string
): DistillCandidateRecord[] {
  const tenants = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  const tenantSlugs =
    tenants === 'all'
      ? withExecutionContext('chronos_localadmin', () =>
          listTenants().map((tenant) => tenant.tenant_slug)
        )
      : tenants;
  const scoped = listDistillCandidateRecordsForTenants({
    tenantSlugs,
    organizationIds: strictViewerScopeOrganizationIds(viewer),
    projectIds: strictViewerScopeProjectIds(viewer),
    tierAccess: withOpsViewerDefaults(viewer).tierAccess.filter((tier) => tier !== 'personal'),
  });
  return [...listDistillCandidateRecords(), ...scoped].filter((candidate) =>
    distillCandidateVisibleToViewer(candidate, viewer, requestedTenant)
  );
}

export class DistillCandidateAmbiguityError extends Error {}

export function resolveDistillCandidateForViewer(
  candidateId: string,
  viewer: ViewerContext,
  requestedTenant?: string
): DistillCandidateRecord | null {
  const matches = listDistillCandidatesForViewer(viewer, requestedTenant).filter(
    (candidate) => candidate.candidate_id === candidateId
  );
  if (matches.length > 1)
    throw new DistillCandidateAmbiguityError(
      'Distill candidate identity is ambiguous; narrow the viewer scope.'
    );
  return matches[0] ?? null;
}

/**
 * D8: reuse proposals that live on the MemoryCandidate queue (background
 * review, execution feedback, learning intake, service procedures, mission
 * seeds), projected for display. Visibility is the queue row's own scope
 * checked against the server-resolved viewer — never a client parameter.
 */
export function listReuseProposalsForViewer(
  viewer: ViewerContext,
  requestedTenant?: string,
  rows: readonly MemoryCandidate[] = listMemoryPromotionCandidates()
): FacadeProposalRecord[] {
  return rows
    .filter((row) => row.origin && memoryCandidateVisibleToViewer(row, viewer, requestedTenant))
    .flatMap((row) => {
      const view = projectAnyFacadeProposal(row);
      return view ? [view] : [];
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function resolveReuseProposalForViewer(
  candidateId: string,
  viewer: ViewerContext,
  requestedTenant?: string
): FacadeProposalRecord | null {
  const matches = listReuseProposalsForViewer(viewer, requestedTenant).filter(
    (proposal) => proposal.candidate_id === candidateId
  );
  if (matches.length > 1)
    throw new DistillCandidateAmbiguityError(
      'Distill candidate identity is ambiguous; narrow the viewer scope.'
    );
  return matches[0] ?? null;
}
