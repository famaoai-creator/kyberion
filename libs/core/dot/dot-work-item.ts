import { dotGoalRefLabel, type DotCharter } from './dot-charter.js';
import { assertDotActionJudgmentBinding, type DotActionRecord } from './dot-action-ledger.js';
import { parseDotJudgmentBinding } from './dot-judgment-binding.js';
import type { CreateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import { buildWorkItemCreation } from '../workforce/work-coordination-identity.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import {
  dotAdmissionItemId,
  dotAdmissionMissionId,
  dotRecordAdmissionMatches,
  assertDotJudgmentProposalCharter,
} from './dot-admission-identity.js';

function workItemDescription(charter: DotCharter, record: DotActionRecord): string {
  return [
    record.objective,
    charter.work_binding ? `Organization operation: ${charter.work_binding.operation_id}` : '',
    record.rationale ? `\nRationale: ${record.rationale}` : '',
    `\nProposed by ${'dot:' + charter.dot_id} (${charter.title}) under role ${charter.authority.authority_role}; requested shape: ${record.work_shape}; decision: ${record.decision ?? 'n/a'}.`,
    dotGoalRefLabel(charter) ? `Contributes to: ${dotGoalRefLabel(charter)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Real stores still verify original history; injected finders must prove this strict projection. */
export function assertDotExistingWorkItem(
  record: DotActionRecord,
  existing: WorkItem | undefined,
  input: ReturnType<typeof dotWorkItemInput>,
  injected: boolean
): void {
  if (!existing) return;
  const original = parseDotJudgmentBinding(record.semantic_judgment);
  const persisted = parseDotJudgmentBinding(existing.metadata?.semantic_judgment);
  if (
    Boolean(original) !== Boolean(persisted) ||
    (original && judgmentCanonicalHash(original) !== judgmentCanonicalHash(persisted))
  )
    throw new Error('Existing WorkItem judgment origin differs from the immutable admission');
  if (existing.metadata?.action_ref && existing.metadata.action_ref !== record.action_ref)
    throw new Error('dot work item identity conflict');
  if (!injected || !original) return;
  // No original store history is supplied by this injected port. Later identity edits are
  // unsupported; lifecycle status/version/attempt updates are preserved without reopening work.
  const expected = buildWorkItemCreation(input);
  const fields = [
    'item_id',
    'title',
    'description',
    'priority',
    'source',
    'source_ref',
    'project_id',
    'context',
    'metadata',
    'labels',
    'dependencies',
  ] as const;
  const projection = (value: WorkItem) =>
    Object.fromEntries(fields.map((field) => [field, value[field]]));
  if (judgmentCanonicalHash(projection(existing)) !== judgmentCanonicalHash(projection(expected)))
    throw new Error('Existing injected WorkItem immutable creation envelope differs');
}

/** One immutable creation envelope, shared by initial admission and recovery. */
export function dotWorkItemInput(
  charter: DotCharter,
  record: DotActionRecord,
  rootDir?: string,
  existing?: { item_id: string; source_ref: string }
): CreateWorkItemInput & { itemId: string } {
  assertDotActionJudgmentBinding(record);
  const judgment = parseDotJudgmentBinding(record.semantic_judgment);
  if (judgment) assertDotJudgmentProposalCharter(charter, record.admission!.proposal);
  if (!dotRecordAdmissionMatches(charter, record))
    throw new Error(
      '[DOT_WORK_BINDING] Operation responsibility differs from the admitted work; reconcile instead of relabeling.'
    );
  const legacy =
    existing &&
    !judgment &&
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
      ...(judgment ? { semantic_judgment: judgment } : {}),
      ...(charter.work_binding ? { operation_id: charter.work_binding.operation_id } : {}),
      ...(record.mission_admission
        ? {
            mission_admission: record.mission_admission,
            mandate_ref: record.mission_admission.mandate_ref,
            mandate_facts: record.mission_admission.mandate_facts,
            mission_id: dotAdmissionMissionId(record.action_ref),
          }
        : {}),
      ...(record.admission_only
        ? { admission_only: true, gate_action_id: record.gate_action_id }
        : {}),
      ...(record.continuous_work ? { continuous_work: record.continuous_work } : {}),
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
