/** CLI-only, read-only outcome projection for one bounded diagnostic pass. */
import { isDeepStrictEqual } from 'node:util';
import { currentDotActions } from '@agent/core/dot/dot-dispatch';
import { readDotWorkResults } from '@agent/core/dot/dot-executor';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { DotWorkResultRow } from '@agent/core/dot/dot-state-paths';
import {
  loadApprovalRequest,
  isApprovalRequestExpired,
} from '@agent/core/governance/approval-store';
import { AUTONOMY_APPROVAL_CHANNEL } from '@agent/core/governance/approval-decision-card';
import { getWorkItem } from '@agent/core/workforce/work-coordination';
import { frontDeskBindingsEqual } from '@agent/core/surface/front-desk-execution';
import {
  listConfiguredFrontDeskExecutions,
  readFrontDeskConversationWork,
} from '@agent/core/surface/front-desk-conversation-store';
import type { FrontDeskExecutionMapping } from '@agent/core/surface/front-desk-execution-contract';

export const FIRST_JOB_TICK_OUTCOMES = [
  'uncertain',
  'configuration_changed',
  'failed',
  'held',
  'awaiting_approval',
  'refused',
  'expired',
  'artifact_verified',
  'noop',
] as const;
export type FirstJobTickOutcome = (typeof FIRST_JOB_TICK_OUTCOMES)[number];
export type FirstJobTickActor = 'user' | 'operator' | 'none';
export type FirstJobTickAction =
  | 'inspect_execution'
  | 'inspect_configuration'
  | 'review_approval'
  | 'review_request'
  | 'view_artifact'
  | 'none';
export interface FirstJobTickReadback {
  outcome: FirstJobTickOutcome;
  next_actor: FirstJobTickActor;
  next_action: FirstJobTickAction;
  outcomes: Record<FirstJobTickOutcome, number>;
}

/** Fixed vocabulary only: never serialize request text, raw errors, paths or result summaries. */
export function summarizeFirstJobTick(
  outcomes: FirstJobTickOutcome[],
  current: FirstJobTickOutcome[] = outcomes
): FirstJobTickReadback {
  const counts = Object.fromEntries(
    FIRST_JOB_TICK_OUTCOMES.map((key) => [key, 0])
  ) as FirstJobTickReadback['outcomes'];
  for (const outcome of outcomes) counts[outcome]++;
  const outcome = FIRST_JOB_TICK_OUTCOMES.find((key) => current.includes(key)) ?? 'noop';
  const next: Record<FirstJobTickOutcome, [FirstJobTickActor, FirstJobTickAction]> = {
    uncertain: ['operator', 'inspect_execution'],
    configuration_changed: ['operator', 'inspect_configuration'],
    failed: ['operator', 'inspect_execution'],
    held: ['operator', 'inspect_execution'],
    awaiting_approval: ['user', 'review_approval'],
    refused: ['user', 'review_request'],
    expired: ['user', 'review_request'],
    artifact_verified: ['user', 'view_artifact'],
    noop: ['none', 'none'],
  };
  const [next_actor, next_action] = next[outcome];
  return { outcome, next_actor, next_action, outcomes: counts };
}

/**
 * Runs in the existing charter scope. The work projection reopens and verifies
 * the actual artifact bytes. A returned/persisted executor "done" is never proof.
 * This adds no tenant reader, approval, transcript write, retry or lease recovery.
 */
export function readFirstJobTickStatus(
  charter: DotCharter,
  mapping: FrontDeskExecutionMapping,
  pipelineDigest: string,
  executorRows: readonly DotWorkResultRow[] = []
): FirstJobTickReadback {
  try {
    const work = readFrontDeskConversationWork(mapping.viewer);
    const entries = listConfiguredFrontDeskExecutions((current) =>
      isDeepStrictEqual(current, mapping)
    );
    const actions = currentDotActions(charter.dot_id);
    const persisted = readDotWorkResults(charter);
    const outcomes: FirstJobTickOutcome[] = [];
    const active: FirstJobTickOutcome[] = [];
    let latestTerminal: { at: number; outcome: FirstJobTickOutcome } | undefined;
    for (const task of work.tasks) {
      if (!task.artifact && !task.executionStatus) continue;
      const record = (outcome: FirstJobTickOutcome) => {
        outcomes.push(outcome);
        if (['refused', 'expired', 'artifact_verified'].includes(outcome)) {
          if (!latestTerminal || task.createdAt >= latestTerminal.at)
            latestTerminal = { at: task.createdAt, outcome };
        } else active.push(outcome);
      };
      if (task.executionStatus === 'terminated_unstarted') continue;
      const entry = entries.find((value) => value.binding.request_id === task.id);
      if (!entry) {
        record('uncertain');
        continue;
      }
      const { binding, request } = entry;
      if (request.status === 'invalidated' || binding.config_digest !== pipelineDigest) {
        record('configuration_changed');
        continue;
      }
      if (task.executionStatus === 'work_completed' && task.artifact?.verification === 'verified') {
        record('artifact_verified');
        continue;
      }
      const action = actions.find((value) =>
        frontDeskBindingsEqual(binding, value.front_desk_execution)
      );
      const item = task.workItemId ? getWorkItem(task.workItemId) : undefined;
      const attempt = item?.current_attempt_id ?? item?.attempts?.at(-1)?.run_id;
      const result =
        item &&
        [...persisted, ...executorRows]
          .filter(
            (row) =>
              row.dot_id === charter.dot_id &&
              row.work_item_id === item.item_id &&
              row.action_ref === item.metadata?.action_ref &&
              row.attempt_id === attempt
          )
          .at(-1);
      if (
        task.turnState === 'uncertain' ||
        task.executionStatus === 'uncertain' ||
        task.executionStatus === 'unknown' ||
        item?.attempts?.some(
          (entry) => entry.run_id === attempt && entry.failure_reason === 'lease_expired'
        ) ||
        (result?.status === 'blocked' && result.mode !== 'escalated') ||
        result?.status === 'done'
      ) {
        record('uncertain');
        continue;
      }
      if (result?.status === 'failed') {
        record(result.reason_code === 'pre_effect_failure' ? 'failed' : 'uncertain');
        continue;
      }
      if (item?.status === 'in_progress' || request.status === 'cancel_requested') {
        record('held');
        continue;
      }
      const approval = action?.request_id
        ? loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, action.request_id)
        : undefined;
      const expectedScope = { ...charter.scope, viewer_principal: mapping.viewer.principalId };
      if (
        approval &&
        (approval.requestedBy !== 'dot:' + charter.dot_id ||
          (
            ['viewer_principal', 'tenant_slug', 'organization_id', 'project_id', 'tier'] as const
          ).some(
            (key) => (approval.scope?.[key] ?? undefined) !== (expectedScope[key] ?? undefined)
          ))
      ) {
        record('uncertain');
        continue;
      }
      if (approval?.status === 'rejected' || approval?.status === 'cancelled') {
        record('refused');
        continue;
      }
      if (
        approval &&
        (approval.status === 'expired' || isApprovalRequestExpired(approval, Date.now()))
      ) {
        record('expired');
        continue;
      }
      if (action && ['refused', 'declined', 'shadow'].includes(action.status)) {
        record('refused');
        continue;
      }
      if (item) {
        record('held');
        continue;
      }
      // The generic awaiting_approval projection also covers absent or already
      // approved cards. Only a currently pending bound card means a human is next.
      record(
        action?.status === 'parked' && approval?.status === 'pending' ? 'awaiting_approval' : 'held'
      );
    }
    // Current-pass errors take precedence even when a previous persisted result
    // still verifies or a returned row cannot be matched to a projected request.
    for (const row of executorRows) {
      const entry = entries.find((value) => value.binding.work_item_id === row.work_item_id);
      const projected =
        entry &&
        work.tasks.find(
          (task) => task.id === entry.binding.request_id && task.workItemId === row.work_item_id
        );
      const item = projected ? getWorkItem(row.work_item_id) : undefined;
      const attempt = item?.current_attempt_id ?? item?.attempts?.at(-1)?.run_id;
      const bound =
        entry &&
        item &&
        item.metadata?.dot_id === charter.dot_id &&
        row.action_ref === item.metadata?.action_ref &&
        frontDeskBindingsEqual(entry.binding, item.metadata?.front_desk_execution) &&
        // Skipped rows describe a non-attempt and carry no attempt id. They may
        // establish a hold, never success or an effect-free failure.
        (row.status === 'skipped' || row.attempt_id === attempt);
      const issue: FirstJobTickOutcome | undefined =
        row.dot_id !== charter.dot_id || !bound
          ? 'uncertain'
          : row.status === 'failed'
            ? row.reason_code === 'pre_effect_failure'
              ? 'failed'
              : 'uncertain'
            : row.status === 'blocked'
              ? row.mode === 'escalated'
                ? 'held'
                : 'uncertain'
              : row.status === 'skipped'
                ? 'held'
                : row.status === 'done'
                  ? undefined
                  : 'uncertain';
      if (issue) {
        if (!outcomes.includes(issue)) outcomes.push(issue);
        if (!active.includes(issue)) active.push(issue);
      }
    }
    // An executor row without any current request projection cannot establish success.
    if (executorRows.length && !outcomes.length) {
      outcomes.push('uncertain');
      active.push('uncertain');
    }
    // Retain historical terminal counts, but an older refusal/expiry must not
    // hide a newer verified request. Any unresolved work still takes priority.
    return summarizeFirstJobTick(
      outcomes,
      active.length ? active : latestTerminal ? [latestTerminal.outcome] : []
    );
  } catch {
    return summarizeFirstJobTick(['uncertain']);
  }
}
