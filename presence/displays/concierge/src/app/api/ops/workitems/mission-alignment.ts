/** Existing scoped WorkItem action -> governed alignment CLI, never a shell or a new execution API. */
import { buildExecutionEnv, withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync, safeExistsSync } from '@agent/core/secure-io';
import { getWorkItem, type WorkItem } from '@agent/core/workforce/work-coordination';
import {
  listApprovalRequests,
  isApprovalRequestExpired,
  computeApprovalPayloadHash,
} from '@agent/core/governance/approval-store';
import {
  buildMissionAdmissionBrief,
  resolveDotMissionAdmission,
  resolveDotMissionAdmissionScope,
} from '@agent/core/mission/mission-admission';

export async function requestWorkItemMissionAlignment(authorized: WorkItem) {
  const scope = authorized.context;
  if (
    !scope?.tenant_slug ||
    authorized.metadata?.requested_work_shape !== 'mission' ||
    authorized.metadata?.admission_only !== true ||
    !['ready', 'blocked'].includes(authorized.status)
  )
    throw new Error('only a held typed mission intake can request alignment');
  const script = pathResolver.rootResolve('dist/scripts/mission_alignment_request.js');
  if (!safeExistsSync(script)) throw new Error('build the governed mission alignment script first');
  const env = buildExecutionEnv(process.env, 'mission_controller');
  delete env.MISSION_ID;
  delete env.KYBERION_CUSTOMER;
  delete env.KYBERION_PROJECT_ID;
  env.KYBERION_TENANT = scope.tenant_slug;
  if (scope.organization_id) env.KYBERION_ORGANIZATION_ID = scope.organization_id;
  else delete env.KYBERION_ORGANIZATION_ID;
  // A server-resolved snapshot, not client scope, is the optimistic concurrency boundary.
  const outcome = await safeExecResultAsync(
    process.execPath,
    [
      script,
      '--work-item',
      authorized.item_id,
      '--expected-work-item-version',
      String(authorized.version),
      '--json',
    ],
    { cwd: pathResolver.rootDir(), env, timeoutMs: 120_000, maxOutputMB: 2 }
  );
  return readWorkItemMissionAlignment(authorized, outcome.status !== 0);
}

/** Read-only reconciliation for scoped refresh and uncertain child outcomes. */
export function readWorkItemMissionAlignment(authorized: WorkItem, uncertain = false) {
  const scope = authorized.context;
  if (!scope?.tenant_slug) throw new Error('typed tenant scope required');
  return withExecutionContext(
    'mission_controller',
    () => {
      const current = getWorkItem(authorized.item_id);
      if (
        !current ||
        current.context?.tenant_slug !== scope.tenant_slug ||
        current.context?.organization_id !== scope.organization_id ||
        current.context?.project_id !== scope.project_id ||
        current.title !== authorized.title ||
        current.description !== authorized.description
      )
        throw new Error('work item changed while requesting alignment; reload its current scope');
      const admission = resolveDotMissionAdmission(current);
      const actualScope = resolveDotMissionAdmissionScope(current);
      const missionId = String(current.metadata?.mission_id);
      const payloadHash = computeApprovalPayloadHash(
        buildMissionAdmissionBrief(current, admission, missionId)
      );
      const effectBinding =
        'mission-admission:' +
        computeApprovalPayloadHash({
          action: 'human_mission_alignment',
          itemId: current.item_id,
          missionId,
          actionRef: current.metadata?.action_ref,
          scope: actualScope,
        });
      const records = listApprovalRequests({
        storageChannels: ['brief'],
        kind: 'mission_gate',
      }).filter((record) => record.source?.missionId === missionId);
      const record = records[0];
      if (
        records.length !== 1 ||
        !record ||
        record.source?.taskId !== current.item_id ||
        record.accountability?.finalDecision !== 'human_only' ||
        record.scope?.tier !== 'confidential' ||
        record.accountability?.payloadHash !== payloadHash ||
        record.accountability.effectBinding !== effectBinding ||
        record.scope?.tenant_slug !== actualScope.tenant_slug ||
        record.scope.organization_id !== actualScope.organization_id ||
        record.scope.project_id !== actualScope.project_id ||
        record.scope.mission_id !== missionId ||
        record.scope.task_id !== current.item_id
      )
        throw new Error(
          !uncertain
            ? 'governed alignment has no matching decision receipt'
            : 'alignment preparation held; inspect original work evidence before retrying'
        );
      const status = record.revocation
        ? 'revoked'
        : isApprovalRequestExpired(record)
          ? 'expired'
          : record.status;
      return {
        item: current,
        admission: {
          requestId: record.id,
          missionId,
          status,
          href:
            '/?section=approvals&request=' +
            encodeURIComponent(record.id) +
            '&mission=' +
            encodeURIComponent(missionId),
        },
      };
    },
    undefined,
    scope.tenant_slug,
    scope.organization_id
  );
}
