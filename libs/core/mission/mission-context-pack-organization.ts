import { withExecutionContext } from '../authority.js';
import { loadOrganizationPurpose } from '../organization/organization-operating-model.js';
import { loadProjectRecord } from '../project/project-registry.js';
import type {
  MissionContextPackOrganizationIntent,
  MissionTier,
} from './mission-context-pack-types.js';

const ORG_INTENT_MAX_OBJECTIVES = 5;
const ORG_INTENT_MAX_KEY_RESULTS = 4;

export function loadScopedOrganizationIntent(input: {
  organizationId: string;
  missionTier: MissionTier;
  tenantSlug?: string;
  projectId?: string;
  rootDir?: string;
}): MissionContextPackOrganizationIntent | undefined {
  const tierOrder: MissionTier[] =
    input.missionTier === 'public'
      ? ['public']
      : input.missionTier === 'confidential'
        ? ['confidential', 'public']
        : ['personal', 'public'];
  const purpose = withExecutionContext(
    'organization_operator',
    () =>
      tierOrder
        .map((tier) =>
          loadOrganizationPurpose(input.organizationId, {
            tier,
            tenantSlug: input.tenantSlug || 'shared',
            ...(input.rootDir ? { rootDir: input.rootDir } : {}),
          })
        )
        .find((record) => record),
    undefined,
    input.tenantSlug,
    input.organizationId
  );
  if (!purpose) return undefined;
  const projectRecord = input.projectId
    ? loadProjectRecord(input.projectId, {
        ...(input.rootDir ? { rootDir: input.rootDir } : {}),
      })
    : null;
  const recordMatchesScope = Boolean(
    projectRecord &&
    projectRecord.tier === input.missionTier &&
    (!input.tenantSlug || projectRecord.tenant_slug === input.tenantSlug)
  );
  const linkedObjectiveIds = new Set(
    (recordMatchesScope ? projectRecord?.objective_ids : undefined) || []
  );
  const objectives = (purpose.objectives || [])
    .filter((objective) => linkedObjectiveIds.has(objective.objective_id))
    .slice(0, ORG_INTENT_MAX_OBJECTIVES)
    .map((objective) => ({
      objective_id: objective.objective_id,
      title: objective.title,
      ...(objective.status ? { status: objective.status } : {}),
      ...(objective.key_results?.length
        ? {
            key_results: objective.key_results.slice(0, ORG_INTENT_MAX_KEY_RESULTS).map((kr) => ({
              kr_id: kr.kr_id,
              title: kr.title,
              target: kr.target,
              direction: kr.direction,
              ...(kr.unit ? { unit: kr.unit } : {}),
            })),
          }
        : {}),
    }));
  return {
    organization_id: purpose.organization_id,
    ...(purpose.name ? { name: purpose.name } : {}),
    purpose: purpose.purpose.slice(0, 1200),
    approval_state: purpose.approval_state,
    ...(objectives.length ? { objectives } : {}),
  };
}
