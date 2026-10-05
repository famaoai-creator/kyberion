import { loadOrganizationPurpose } from '../organization/organization-operating-model.js';
import type { ProjectRecord } from './project-registry.js';

/**
 * A project may name the organization objectives it advances. Each one must
 * be an objective of the project's own organization, so the link cannot
 * point across organizations or at a typo.
 */
export function assertProjectObjectiveLinks(record: ProjectRecord, rootDir?: string): void {
  if (!record.objective_ids?.length) return;
  if (!record.organization_id) {
    throw new Error(
      `Project '${record.project_id}' links objectives but has no organization_id; objectives belong to an organization.`
    );
  }
  const purpose = loadOrganizationPurpose(record.organization_id, {
    tier: record.tier,
    tenantSlug: record.tenant_slug,
    rootDir,
  });
  const known = new Set((purpose?.objectives || []).map((objective) => objective.objective_id));
  const unknown = record.objective_ids.filter((objectiveId) => !known.has(objectiveId));
  if (unknown.length) {
    throw new Error(
      `Unknown objective(s) for organization '${record.organization_id}': ${unknown.join(', ')}. ` +
        `Declare them with pnpm organization objective add, or check pnpm organization status.`
    );
  }
}
