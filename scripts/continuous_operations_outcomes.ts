/** Scope-exact, read-only feedback from actual work and published artifacts. */
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { readDotWorkResults } from '@agent/core/dot/dot-executor';
import { readDotActionLedger } from '@agent/core/dot/dot-action-ledger';
import { getWorkItem } from '@agent/core/workforce/work-coordination';
import { listArtifactOwnershipRecordsByQuery } from '@agent/core/workforce/artifact-registry';
import { readContinuousWorkOwnerProgress } from '@agent/core/organization/continuous-work-owner';
import type { ContinuousOperationsReport } from '@agent/core/organization/continuous-operations';
export interface ContinuousOutcomeDeps {
  actions?: typeof readDotActionLedger;
  results?: typeof readDotWorkResults;
  item?: typeof getWorkItem;
  artifacts?: typeof listArtifactOwnershipRecordsByQuery;
  progress?: typeof readContinuousWorkOwnerProgress;
}
export function observeContinuousWork(
  charter: DotCharter,
  report: ContinuousOperationsReport,
  rootDir?: string,
  deps: ContinuousOutcomeDeps = {}
) {
  const scope = charter.scope;
  const actions = (deps.actions ?? readDotActionLedger)({ rootDir }).filter(
    (row) => row.dot_id === charter.dot_id
  );
  const results = (deps.results ?? readDotWorkResults)(charter, { rootDir });
  // Exact filtering is required even if a query implementation treats omitted dimensions as wildcards.
  const artifacts = report.inventory.some((entry) => entry.action_ref)
    ? (deps.artifacts ?? listArtifactOwnershipRecordsByQuery)({
        tenantSlug: scope.tenant_slug,
        organizationId: scope.organization_id,
        projectId: scope.project_id,
      }).filter(
        (row) =>
          (row.tenant_slug ?? '') === (scope.tenant_slug ?? '') &&
          row.organization_id === scope.organization_id &&
          (row.project_id ?? '') === (scope.project_id ?? '') &&
          row.metadata?.tier === scope.tier
      )
    : [];
  return report.inventory.flatMap((entry) => {
    if (!entry.action_ref) return [];
    const action = actions.filter((row) => row.action_ref === entry.action_ref).at(-1);
    const item = action?.work_item_id
      ? (deps.item ?? getWorkItem)(action.work_item_id, { rootDir })
      : null;
    if (
      item &&
      ((item.context?.tenant_slug ?? '') !== (scope.tenant_slug ?? '') ||
        item.context?.organization_id !== scope.organization_id ||
        (item.context?.project_id ?? '') !== (scope.project_id ?? ''))
    )
      throw new Error('Continuous outcome WorkItem scope mismatch');
    const result = results
      .filter(
        (row) => row.action_ref === entry.action_ref && (!item || row.work_item_id === item.item_id)
      )
      .at(-1);
    const managed = item?.metadata?.continuous_work
      ? (deps.progress ?? readContinuousWorkOwnerProgress)(charter, item, { rootDir })
      : undefined;
    const missionIds = new Set(
      Object.values(managed?.missions ?? {})
        .filter((m) => m.created)
        .map((m) => m.mission_id)
    );
    const managedArtifacts =
      managed?.project_id && missionIds.size
        ? (deps.artifacts ?? listArtifactOwnershipRecordsByQuery)({
            tenantSlug: scope.tenant_slug,
            organizationId: scope.organization_id,
            projectId: managed.project_id,
          }).filter(
            (row) =>
              (row.tenant_slug ?? '') === (scope.tenant_slug ?? '') &&
              row.organization_id === scope.organization_id &&
              row.project_id === managed.project_id &&
              row.metadata?.tier === scope.tier &&
              !!row.mission_id &&
              missionIds.has(row.mission_id)
          )
        : [];
    return [
      {
        rule_id: entry.rule_id,
        action_ref: entry.action_ref,
        dot_status: action?.status,
        approval_request_id: action?.request_id,
        work_item_id: item?.item_id,
        work_item_status: item?.status,
        execution_status: result?.status,
        completed_at: result?.completed_at,
        artifact_refs: item
          ? [
              ...artifacts.filter((row) => row.metadata?.work_item_id === item.item_id),
              ...managedArtifacts,
            ].map((row) => ({ artifact_id: row.artifact_id, evidence_refs: row.evidence_refs }))
          : [],
        ...(managed ? { managed_work: managed } : {}),
      },
    ];
  });
}
