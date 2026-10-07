/** CLI-only, request-bound observation. Never an approval or a safe-retry proof. */
import { isDeepStrictEqual } from 'node:util';
import { resolveIdentityContext } from '@agent/core/authority';
import {
  compileSchema,
  getRegisteredEnvBool,
  getRegisteredEnvText,
  readJsonLines,
} from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { assertSafeRepositoryPath, safeLstat } from '@agent/core/secure-io';
import {
  findRepoDotCharter,
  requireCurrentFrontDeskDiagnosticDot,
  type DotCharter,
} from '@agent/core/dot/dot-charter';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import {
  DOT_ACTION_LEDGER_PATH,
  readDotActionLedgerStrict,
  type DotActionRecord,
} from '@agent/core/dot/dot-action-ledger';
import {
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotWorkResultRow,
} from '@agent/core/dot/dot-state-paths';
import {
  loadApprovalRequest,
  isApprovalRequestExpired,
} from '@agent/core/governance/approval-store';
import { getWorkItem, listActiveWorkLeases } from '@agent/core/workforce/work-coordination';
import {
  conversationRef,
  inspectFrontDeskExecution,
  listConfiguredFrontDeskExecutions,
  readFrontDeskConversationRequestWork,
  readFrontDeskExecutionRecovery,
} from '@agent/core/surface/front-desk-conversation-store';
import {
  FIRST_JOB_DIAGNOSTIC_PROTOCOL,
  FRONT_DESK_RECEIPT_PIPELINE,
  frontDeskMappingDigest,
  getFrontDeskExecutionMapping,
  loadFrontDeskExecutionPolicy,
  type FrontDeskExecutionBinding,
} from '@agent/core/surface/front-desk-execution-contract';
import {
  frontDeskBindingsEqual,
  frontDeskExecutionProposal,
} from '@agent/core/surface/front-desk-execution-proposal';
import { createFirstJobTenantStatusAssertion } from './onboarding_first_job_tenant_status.js';
import { isFirstJobDiagnosticMapping } from '@agent/core/surface/first-job-admission';
import {
  firstJobActionMatches,
  firstJobApprovalMatches,
} from '@agent/core/surface/first-job-approval-binding';
import {
  firstJobApprovalEffect,
  hasVerifiedFirstJobDecision,
} from '@agent/core/surface/first-job-approval-proof';

export type FirstJobRequestStatus =
  | 'unavailable'
  | 'intake_not_observed'
  | 'awaiting_approval'
  | 'approved_awaiting_tick'
  | 'queued'
  | 'running'
  | 'artifact_verified'
  | 'refused'
  | 'expired'
  | 'terminated_unstarted'
  | 'uncertain';
type Actor = 'user' | 'operator' | 'none';
type Action =
  | 'inspect_configuration'
  | 'inspect_tick'
  | 'review_approval'
  | 'wait'
  | 'view_artifact'
  | 'review_request'
  | 'inspect_execution'
  | 'none';
export interface FirstJobRequestSnapshot {
  mode: 'status';
  read_only: true;
  authorizes_execution: false;
  status: FirstJobRequestStatus;
  next_actor: Actor;
  next_action: Action;
  notice: string;
  request?: { request_id: string; revision: number };
}
const next: Record<FirstJobRequestStatus, [Actor, Action]> = {
  unavailable: ['operator', 'inspect_configuration'],
  intake_not_observed: ['operator', 'inspect_tick'],
  awaiting_approval: ['user', 'review_approval'],
  approved_awaiting_tick: ['operator', 'inspect_tick'],
  queued: ['operator', 'inspect_tick'],
  running: ['none', 'wait'],
  artifact_verified: ['user', 'view_artifact'],
  refused: ['user', 'review_request'],
  expired: ['user', 'review_request'],
  terminated_unstarted: ['none', 'none'],
  uncertain: ['operator', 'inspect_execution'],
};
function snapshot(
  status: FirstJobRequestStatus,
  binding?: FrontDeskExecutionBinding
): FirstJobRequestSnapshot {
  const [next_actor, next_action] = next[status];
  return {
    mode: 'status',
    read_only: true,
    authorizes_execution: false,
    status,
    next_actor,
    next_action,
    notice:
      'Observation only. This snapshot does not approve work or establish that retrying is safe.',
    ...(binding ? { request: { request_id: binding.request_id, revision: binding.revision } } : {}),
  };
}
export const firstJobStatusUnavailable = (): FirstJobRequestSnapshot => snapshot('unavailable');
export const isFirstJobRequestId = (value: string): boolean =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

/** Only ENOENT is absence. No directory creation, forgiving exists check or locks. */
function retainedFile(file: string): boolean {
  const guarded = assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  try {
    const stat = safeLstat(guarded);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error('invalid_retained_evidence');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** The forgiving executor reader cannot establish absence after a corrupt row. */
function strictResults(charter: DotCharter): DotWorkResultRow[] {
  const file = dotStatePath(charter, DOT_WORK_RESULTS_FILE);
  if (!retainedFile(file)) return [];
  return readJsonLines<DotWorkResultRow>(file).map((row) => {
    if (
      !row ||
      !['dot_id', 'work_item_id', 'action_ref', 'started_at', 'completed_at'].every(
        (key) => typeof row[key as keyof DotWorkResultRow] === 'string'
      ) ||
      !['done', 'blocked', 'failed', 'skipped'].includes(row.status) ||
      !['goal_turn', 'delegated', 'pipeline', 'escalated'].includes(row.mode) ||
      !Number.isFinite(Date.parse(row.started_at)) ||
      !Number.isFinite(Date.parse(row.completed_at))
    )
      throw new Error('invalid_result_evidence');
    return row;
  });
}
function linkedAction(row: DotActionRecord, binding: FrontDeskExecutionBinding): boolean {
  return (
    row.front_desk_execution?.request_id === binding.request_id ||
    row.front_desk_execution?.work_item_id === binding.work_item_id ||
    row.work_item_id === binding.work_item_id ||
    row.action_ref === 'frontdesk-' + binding.work_item_id
  );
}

/** No setup planner, caller-created viewer, broad tenant registry read, or maintenance. */
export async function readFirstJobStatus(
  tenant: string,
  requestId: string
): Promise<FirstJobRequestSnapshot> {
  try {
    if (
      !isValidTenantSlug(tenant) ||
      !isFirstJobRequestId(requestId) ||
      getRegisteredEnvText('KYBERION_ROLE_ASSUMPTION_TRACE') ||
      getRegisteredEnvText('MISSION_ID') ||
      getRegisteredEnvText('SYSTEM_ROLE') ||
      getRegisteredEnvBool('KYBERION_SUDO') ||
      (getRegisteredEnvText('KYBERION_TENANT') &&
        getRegisteredEnvText('KYBERION_TENANT') !== tenant)
    )
      return firstJobStatusUnavailable();
    const identity = resolveIdentityContext();
    if (
      identity.missionId ||
      identity.authorities.some((value) => value === 'SUDO' || value === 'SECRET_READ')
    )
      return firstJobStatusUnavailable();
    const candidates = loadFrontDeskExecutionPolicy().mappings.filter(
      ({ viewer }) =>
        viewer.principalId === 'human:presence-studio-localadmin' &&
        viewer.source === 'loopback' &&
        viewer.role === 'localadmin' &&
        viewer.tenantSlugs !== 'all' &&
        viewer.tenantSlugs.length === 1 &&
        viewer.tenantSlugs[0] === tenant
    );
    if (candidates.length !== 1 || !isFirstJobDiagnosticMapping(candidates[0]))
      return firstJobStatusUnavailable();
    const mapping = candidates[0];
    const charter = findRepoDotCharter(mapping.dotId)?.charter;
    if (!charter) return firstJobStatusUnavailable();
    requireCurrentFrontDeskDiagnosticDot(charter);
    for (const [key, expected] of [
      ['KYBERION_ORGANIZATION_ID', charter.scope.organization_id],
      ['KYBERION_PROJECT_ID', charter.scope.project_id],
    ] as const) {
      const ambient = getRegisteredEnvText(key);
      if (ambient && ambient !== expected) return firstJobStatusUnavailable();
    }
    return await runAsDotCharter(charter, async () => {
      const entries = listConfiguredFrontDeskExecutions((current) =>
        isDeepStrictEqual(current, mapping)
      ).filter(({ binding }) => binding.request_id === requestId);
      if (entries.length !== 1) return firstJobStatusUnavailable();
      const binding = entries[0].binding;
      if (
        binding.diagnostic_protocol !== FIRST_JOB_DIAGNOSTIC_PROTOCOL ||
        binding.conversation_key !== conversationRef(mapping.viewer).key ||
        binding.config_digest !== frontDeskMappingDigest(mapping) ||
        !isDeepStrictEqual(getFrontDeskExecutionMapping(binding), mapping)
      )
        return firstJobStatusUnavailable();
      const request = readFrontDeskExecutionRecovery(binding);
      if (!frontDeskBindingsEqual(request.binding, binding)) return firstJobStatusUnavailable();
      const result = (status: FirstJobRequestStatus) => snapshot(status, binding);
      if (request.status === 'invalidated' || request.status === 'cancel_requested')
        return result('uncertain');
      const task = readFrontDeskConversationRequestWork(mapping.viewer, requestId);
      if (!task) return firstJobStatusUnavailable();
      if (request.status === 'terminated_unstarted')
        return result(
          task.executionStatus === 'terminated_unstarted' ? 'terminated_unstarted' : 'uncertain'
        );
      if (!inspectFrontDeskExecution(binding, charter).ok) return firstJobStatusUnavailable();
      createFirstJobTenantStatusAssertion(charter, mapping)(tenant, {
        charter,
        proposal: frontDeskExecutionProposal(binding),
      });
      let history: DotActionRecord[];
      let rows: DotWorkResultRow[];
      try {
        history = retainedFile(DOT_ACTION_LEDGER_PATH) ? readDotActionLedgerStrict() : [];
        rows = strictResults(charter);
      } catch (error) {
        // Permission/scope failures use the same unavailable envelope as a missing request.
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code === 'EACCES' ||
          code === 'EPERM' ||
          (error instanceof Error &&
            /\[(?:SECURITY|ROLE_VIOLATION|POLICY_VIOLATION|ROLE_ASSUMPTION_DENIED|RESOURCE_PATH_SCOPE)\]/.test(
              error.message
            ))
        )
          return firstJobStatusUnavailable();
        return result('uncertain');
      }
      const latest = [...new Map(history.map((row) => [row.action_ref, row])).values()];
      const actions = latest.filter((row) => linkedAction(row, binding));
      const item = getWorkItem(binding.work_item_id);
      if (
        item &&
        !compileSchema(
          pathResolver.rootResolve('knowledge/product/schemas/governed-work-item.schema.json')
        )(item)
      )
        return result('uncertain');
      const relevantResults = rows.filter((row) => row.work_item_id === binding.work_item_id);
      if (actions.length > 1) return result('uncertain');
      const action = actions[0];
      if (!action) {
        return result(
          item || relevantResults.length || task.turnState === 'uncertain'
            ? 'uncertain'
            : 'intake_not_observed'
        );
      }
      if (
        !firstJobActionMatches(charter, binding, action) ||
        history
          .filter((row) => linkedAction(row, binding))
          .some(
            (row) =>
              row.action_ref !== action.action_ref ||
              !firstJobActionMatches(charter, binding, row) ||
              (action.request_id && row.request_id && row.request_id !== action.request_id)
          ) ||
        (action.request_id &&
          latest.some(
            (row) => row.action_ref !== action.action_ref && row.request_id === action.request_id
          ))
      )
        return result('uncertain');
      if (
        item &&
        (action.status !== 'dispatched' ||
          action.work_item_id !== item.item_id ||
          item.metadata?.dot_id !== charter.dot_id ||
          item.metadata?.action_ref !== action.action_ref ||
          item.metadata?.approval_request_id !== action.request_id ||
          item.metadata?.pipeline_ref !== FRONT_DESK_RECEIPT_PIPELINE ||
          item.metadata?.requested_work_shape !== 'pipeline' ||
          !frontDeskBindingsEqual(binding, item.metadata?.front_desk_execution) ||
          item.context?.tenant_slug !== charter.scope.tenant_slug ||
          item.context?.organization_id !== charter.scope.organization_id ||
          item.context?.project_id !== (charter.scope.project_id ?? 'default'))
      )
        return result('uncertain');
      const attempt = item?.current_attempt_id ?? item?.attempts?.at(-1)?.run_id;
      const attempts = item?.attempts ?? [];
      if (
        item &&
        (!Array.isArray(attempts) ||
          attempts.some(
            (entry) =>
              !entry ||
              typeof entry.attempt_id !== 'string' ||
              !entry.attempt_id.trim() ||
              typeof entry.run_id !== 'string' ||
              !entry.run_id.trim() ||
              !Number.isFinite(Date.parse(entry.started_at)) ||
              !['running', 'released', 'completed', 'blocked', 'failed', 'handed_off'].includes(
                entry.status
              )
          ) ||
          new Set(attempts.map((entry) => entry.run_id)).size !== attempts.length)
      )
        return result('uncertain');
      const currentAttempt = attempts.find((entry) => entry.run_id === attempt);
      if (
        item &&
        ['done', 'in_progress'].includes(item.status) &&
        (!attempt ||
          !currentAttempt ||
          attempts.at(-1)?.run_id !== attempt ||
          (item.status === 'done' && !['completed', 'released'].includes(currentAttempt.status)) ||
          (item.status === 'in_progress' &&
            (currentAttempt.status !== 'running' ||
              currentAttempt.lease_id !== item.lease_id ||
              item.current_attempt_id !== attempt)))
      )
        return result('uncertain');
      const execution = relevantResults
        .filter(
          (row) =>
            row.dot_id === charter.dot_id &&
            row.action_ref === action.action_ref &&
            Boolean(attempt) &&
            row.attempt_id === attempt
        )
        .at(-1);
      // Contradictions invalidate even a previously persisted successful readback.
      if (
        task.turnState === 'uncertain' ||
        task.executionStatus === 'uncertain' ||
        task.executionStatus === 'unknown' ||
        relevantResults.some(
          (row) =>
            row.dot_id !== charter.dot_id ||
            row.action_ref !== action.action_ref ||
            (row.status !== 'skipped' && !attempts.some((entry) => entry.run_id === row.attempt_id))
        ) ||
        currentAttempt?.failure_reason === 'lease_expired' ||
        (!item && (relevantResults.length || action.work_item_id || action.status === 'dispatched'))
      )
        return result('uncertain');
      if (
        item?.status === 'done' &&
        execution?.status === 'done' &&
        task.executionStatus === 'work_completed' &&
        task.artifact?.verification === 'verified'
      )
        return result('artifact_verified');
      if (execution) return result('uncertain');
      if (['refused', 'declined', 'shadow'].includes(action.status))
        return result(item ? 'uncertain' : 'refused');
      if (!action.request_id || action.decision !== 'approve') return result('uncertain');
      const approval = loadApprovalRequest('autonomy', action.request_id);
      const effect = firstJobApprovalEffect(charter, binding);
      if (!firstJobApprovalMatches(charter, action.request_id, effect, approval))
        return result('uncertain');
      if (approval.status === 'rejected' || approval.status === 'cancelled')
        return result(item ? 'uncertain' : 'refused');
      if (!approval.expiresAt || !Number.isFinite(Date.parse(approval.expiresAt)))
        return result('uncertain');
      if (approval.status === 'expired' || isApprovalRequestExpired(approval, Date.now()))
        return result(item?.status === 'in_progress' ? 'uncertain' : 'expired');
      if (approval.status === 'pending')
        return result(
          !item && action.status === 'parked' && !approval.diagnosticDecision
            ? 'awaiting_approval'
            : 'uncertain'
        );
      if (!hasVerifiedFirstJobDecision(approval, charter, binding, Date.now()))
        return result('uncertain');
      if (!item) return result(action.status === 'parked' ? 'approved_awaiting_tick' : 'uncertain');
      if (item.status === 'ready') return result('queued');
      if (item.status === 'in_progress') {
        const leases = listActiveWorkLeases().filter((entry) => entry.item_id === item.item_id);
        const lease = leases.length === 1 ? leases[0] : undefined;
        return result(
          lease &&
            typeof lease.holder_peer_id === 'string' &&
            lease.holder_peer_id.trim() &&
            attempt &&
            lease.lease_id === item.lease_id &&
            lease.holder_peer_id === currentAttempt?.actor_peer_id &&
            lease.holder_peer_id === item.claimed_by_peer_id &&
            lease.holder_user_id === currentAttempt?.actor_user_id &&
            lease.holder_user_id === item.claimed_by_user_id
            ? 'running'
            : 'uncertain'
        );
      }
      return result('uncertain');
    });
  } catch {
    return firstJobStatusUnavailable();
  }
}

/** A separate fail-closed grammar keeps malformed status calls off mutation modes. */
export function parseFirstJobStatusArgs(
  args: readonly string[]
): { tenant: string; requestId: string } | undefined {
  let tenant: string | undefined, requestId: string | undefined;
  let status = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) return undefined;
    seen.add(flag);
    if (flag === '--status') status = true;
    else if (flag === '--tenant' || flag === '--request-id') {
      const value = args[++i];
      if (!value || value.startsWith('-')) return undefined;
      if (flag === '--tenant') tenant = value;
      else requestId = value;
    } else if (flag !== '--json' && flag !== '--quiet') return undefined;
  }
  return status &&
    tenant &&
    requestId &&
    isValidTenantSlug(tenant) &&
    isFirstJobRequestId(requestId)
    ? { tenant, requestId }
    : undefined;
}
