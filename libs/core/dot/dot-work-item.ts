import { dotGoalRefLabel, type DotCharter } from './dot-charter.js';
import type { DotActionRecord } from './dot-action-ledger.js';
import type { CreateWorkItemInput } from '../workforce/work-coordination-types.js';
import { dotAdmissionItemId } from './dot-admission-identity.js';

function workItemDescription(charter: DotCharter, record: DotActionRecord): string {
  return [
    record.objective,
    record.rationale ? `\nRationale: ${record.rationale}` : '',
    `\nProposed by ${'dot:' + charter.dot_id} (${charter.title}) under role ${charter.authority.authority_role}; requested shape: ${record.work_shape}; decision: ${record.decision ?? 'n/a'}.`,
    dotGoalRefLabel(charter) ? `Contributes to: ${dotGoalRefLabel(charter)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** One immutable creation envelope, shared by initial admission and recovery. */
export function dotWorkItemInput(
  charter: DotCharter,
  record: DotActionRecord,
  rootDir?: string,
  existing?: { item_id: string; source_ref: string }
): CreateWorkItemInput & { itemId: string } {
  const legacy =
    existing &&
    !record.front_desk_execution &&
    existing.item_id !== dotAdmissionItemId(record.action_ref);
  const actor = 'dot:' + charter.dot_id;
  return {
    ...(record.front_desk_execution
      ? {
          itemId: record.front_desk_execution.work_item_id,
          sourceRef: record.front_desk_execution.request_digest,
        }
      : legacy
        ? { itemId: existing.item_id, sourceRef: existing.source_ref }
        : { itemId: dotAdmissionItemId(record.action_ref), sourceRef: record.action_ref }),
    ...(rootDir ? { rootDir: rootDir } : {}),
    title: record.title,
    description: workItemDescription(charter, record),
    status: 'ready',
    priority: record.priority ?? 'normal',
    ...(charter.scope.project_id ? { projectId: charter.scope.project_id } : {}),
    context: {
      ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
      ...(charter.scope.organization_id ? { organization_id: charter.scope.organization_id } : {}),
      ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
      work_shape: 'routine_operation',
    },
    metadata: {
      ...(record.front_desk_execution ? { front_desk_execution: record.front_desk_execution } : {}),
      dot_id: charter.dot_id,
      actor_id: actor,
      action_ref: record.action_ref,
      action_id: record.action_id,
      requested_work_shape: record.work_shape,
      authority_role: charter.authority.authority_role,
      ...(record.decision ? { decision: record.decision } : {}),
      ...(record.request_id ? { approval_request_id: record.request_id } : {}),
      ...(record.handoff_to ? { handoff_to: record.handoff_to } : {}),
      ...(dotGoalRefLabel(charter) ? { goal_ref: dotGoalRefLabel(charter) } : {}),
      ...(record.pipeline_ref ? { pipeline_ref: record.pipeline_ref } : {}),
      ...(record.expected_effect ? { expected_effect: record.expected_effect } : {}),
      ...(record.target ? { target: record.target } : {}),
      ...(record.intent ? { intent: record.intent } : {}),
    },
  };
}
