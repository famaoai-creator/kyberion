import { currentExecutionScope } from '../foundation/execution-scope.js';
import { resolveIdentityContext } from '../authority.js';
import {
  getWorkItem,
  updateWorkItem,
  claimWorkItem,
  releaseWorkItem,
  quarantineWorkItemExecution,
} from '../workforce/work-coordination.js';
import { loadState } from '../mission/mission-state.js';
import {
  resolveDotMissionAdmission,
  resolveDotMissionAdmissionScope,
} from '../mission/mission-admission.js';
import {
  buildInformationAssetMissionExecutionPlan,
  type InformationAssetMissionExecutionPlan,
  type InformationAssetWorkInput,
  type InformationAssetWorkOutcome,
} from './work-types.js';

export function resolveInformationAssetMissionExecution(
  workItemId: string,
  options: { rootDir?: string } = {}
): InformationAssetMissionExecutionPlan {
  const item = getWorkItem(workItemId, options);
  if (!item) throw new Error('[INFORMATION_MISSION_ITEM] WorkItem unavailable');
  const missionId = resolveIdentityContext().missionId;
  if (!missionId)
    throw new Error(
      '[INFORMATION_MISSION_REQUIRED] Enter the approved active mission before execution'
    );
  const plan = buildInformationAssetMissionExecutionPlan(item, missionId);
  resolveDotMissionAdmission(item, options);
  const scope = resolveDotMissionAdmissionScope(item, options);
  const current = currentExecutionScope();
  const state = loadState(missionId, options);
  if (
    !current?.tenantBound ||
    current.assumedRole !== 'mission_controller' ||
    current.executionIdentity?.missionId !== missionId ||
    current.tenantSlug !== scope.tenant_slug ||
    current.organizationId !== scope.organization_id ||
    !state ||
    state.status !== 'active' ||
    state.tenant_slug !== scope.tenant_slug ||
    state.organization_id !== scope.organization_id ||
    state.relationships?.project?.project_id !== scope.project_id
  )
    throw new Error(
      '[INFORMATION_MISSION_SCOPE] Active mission, current scope and admitted source must agree'
    );
  return plan;
}
/** Mission owner execution: activation stays exclusively with mission_controller. */
export async function runInformationAssetMissionWork(
  workItemId: string,
  run: (input: InformationAssetWorkInput) => Promise<InformationAssetWorkOutcome>
): Promise<InformationAssetWorkOutcome> {
  const plan = resolveInformationAssetMissionExecution(workItemId);
  let item = getWorkItem(workItemId)!;
  if (item.lease_id || item.status === 'in_progress')
    throw new Error('[INFORMATION_MISSION_CLAIM] WorkItem is already claimed');
  const prior = item.metadata?.information_asset_outcome as InformationAssetWorkOutcome | undefined;
  if (prior?.status === 'completed') return prior;
  if (prior?.status === 'unknown_effect' || prior?.status === 'needs_recheck')
    throw new Error(
      '[INFORMATION_MISSION_UNCERTAIN] Verify the previous effect through governed recovery before reclaiming'
    );
  // Admission completion did no service work. Reopen that same identity through the facade.
  item = updateWorkItem({
    itemId: item.item_id,
    expectedVersion: item.version,
    status: 'ready',
    context: { ...item.context, mission_id: plan.mission_id },
    metadata: { ...item.metadata, information_asset_admission_complete: true },
  });
  const actor = 'mission_controller';
  const claimed = claimWorkItem({
    itemId: item.item_id,
    actorPeerId: actor,
    purpose: 'approved information asset mission work',
    requireNewLease: true,
    expectedVersion: item.version,
    ttlMs: 900000,
  });
  try {
    // Re-read the approved lifecycle receipt after taking the claim.
    resolveInformationAssetMissionExecution(workItemId);
    const outcome = await run({
      workItemId,
      attemptId: claimed.item.current_attempt_id!,
      leaseId: claimed.lease.lease_id,
      dotId: plan.dot_id,
      actorId: actor,
    });
    if (outcome.work_key !== plan.work_key || outcome.work_item_id !== workItemId)
      throw new Error('[INFORMATION_MISSION_RESULT] Execution returned a different identity');
    if (outcome.status === 'unknown_effect' || outcome.status === 'needs_recheck')
      quarantineWorkItemExecution({
        itemId: workItemId,
        leaseId: claimed.lease.lease_id,
        actorPeerId: actor,
        reason: 'Information asset external effect requires independent verification',
      });
    else
      releaseWorkItem({
        itemId: workItemId,
        leaseId: claimed.lease.lease_id,
        actorPeerId: actor,
        nextStatus: outcome.status === 'completed' ? 'done' : 'blocked',
        effectDisposition: outcome.status === 'completed' ? 'completed' : 'pre_effect',
        summary: outcome.status,
      });
    return outcome;
  } catch (error) {
    const current = getWorkItem(workItemId);
    const pending = current?.metadata?.information_asset_outcome as
      InformationAssetWorkOutcome | undefined;
    if (current?.lease_id === claimed.lease.lease_id && pending?.status === 'waiting_approval')
      releaseWorkItem({
        itemId: workItemId,
        leaseId: claimed.lease.lease_id,
        actorPeerId: actor,
        nextStatus: 'blocked',
        effectDisposition: 'pre_effect',
        summary: 'Existing service approval is pending',
      });
    else if (current?.lease_id === claimed.lease.lease_id)
      quarantineWorkItemExecution({
        itemId: workItemId,
        leaseId: claimed.lease.lease_id,
        actorPeerId: actor,
        reason:
          'Information asset execution interrupted; inspect existing run and approval receipts before retrying',
      });
    throw error;
  }
}
