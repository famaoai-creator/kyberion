import { dotGoalRefLabel, findDotCharter, type DotCharter } from './dot-charter.js';
import {
  assertDotActionJudgmentBinding,
  readDotActionLedgerStrict,
  type DotActionRecord,
} from './dot-action-ledger.js';
import {
  dotActionRecordSchemaVersion,
  dotProposalEvidenceHash,
} from './dot-action-ledger-version.js';
import { parseDotJudgmentBinding } from './dot-judgment-binding.js';
import { requestedExecutionShape } from './dot-requested-shape.js';
import { parseFrontDeskExecutionBinding } from '../surface/front-desk-execution-contract.js';
import { frontDeskExecutionProposal } from '../surface/front-desk-execution-proposal.js';
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
    `\nProposed by ${'dot:' + charter.dot_id} (${charter.title}) under role ${charter.authority.authority_role}; requested shape: ${record.execution_shape}; decision: ${record.decision ?? 'n/a'}.`,
    dotGoalRefLabel(charter) ? `Contributes to: ${dotGoalRefLabel(charter)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const PRIVATE_WORK_TITLE = 'Scoped Dot work';
const PRIVATE_WORK_DESCRIPTION =
  'Private execution details are retained in the original scoped Dot action.';

/** Shared WorkItems are routing indexes; the existing scoped action owns private executable content. */
export function restoreDotWorkItemBody(
  charter: DotCharter,
  item: WorkItem,
  rootDir?: string
): WorkItem {
  const marker = item.metadata?.dot_private_body as
    { semantic_hash?: string; scope_hash?: string } | undefined;
  if (!marker) return item; // Same-scope legacy items retain their original creation envelope.
  const actionRef = item.metadata?.action_ref;
  const dotId = item.metadata?.dot_id;
  if (
    typeof actionRef !== 'string' ||
    typeof dotId !== 'string' ||
    typeof marker.semantic_hash !== 'string' ||
    typeof marker.scope_hash !== 'string'
  )
    throw new Error('[DOT_PRIVATE_BODY_UNAVAILABLE] Original scoped action identity is invalid');
  const record = readDotActionLedgerStrict({ rootDir, dotId })
    .filter(
      (row) =>
        row.action_ref === actionRef &&
        row.dot_id === dotId &&
        (row.work_item_id === item.item_id ||
          (!row.work_item_id &&
            (dotAdmissionItemId(row.action_ref) === item.item_id ||
              row.front_desk_execution?.work_item_id === item.item_id)))
    )
    .at(-1);
  if (
    !record?.admission ||
    record.admission.semantic_hash !== marker.semantic_hash ||
    record.admission.scope_hash !== marker.scope_hash ||
    dotProposalEvidenceHash(record.admission.proposal) !== marker.semantic_hash ||
    judgmentCanonicalHash(record.scope) !== judgmentCanonicalHash(charter.scope) ||
    record.admission.authority_role !== item.metadata?.authority_role ||
    !dotRecordAdmissionMatches(
      {
        dot_id: record.dot_id,
        scope: record.scope!,
        ...(item.metadata?.operation_id
          ? { work_binding: { operation_id: String(item.metadata.operation_id) } }
          : {}),
      } as DotCharter,
      record
    )
  )
    throw new Error(
      '[DOT_PRIVATE_BODY_UNAVAILABLE] Original scoped action is missing or differs; reconcile before resuming'
    );
  assertDotActionJudgmentBinding(record);
  const original = record.admission.proposal;
  const routingMatches =
    requestedExecutionShape(item.metadata) === original.execution_shape &&
    item.metadata?.action_id === original.action_id &&
    (item.metadata?.pipeline_ref ?? undefined) === original.pipeline_ref &&
    (item.metadata?.target ?? undefined) === original.target &&
    (item.metadata?.handoff_to ?? undefined) === original.handoff_to &&
    judgmentCanonicalHash(item.metadata?.front_desk_execution ?? null) ===
      judgmentCanonicalHash(original.front_desk_execution ?? null) &&
    judgmentCanonicalHash(item.metadata?.information_asset_work ?? null) ===
      judgmentCanonicalHash(original.information_asset_work ?? null);
  if (!routingMatches)
    throw new Error(
      '[DOT_PRIVATE_BODY_UNAVAILABLE] Shared effect routing differs from the immutable admission'
    );
  return {
    ...item,
    title: original.title,
    description: [original.objective, original.rationale ? `Rationale: ${original.rationale}` : '']
      .filter(Boolean)
      .join('\n'),
    metadata: {
      ...item.metadata,
      ...(original.semantic_judgment ? { semantic_judgment: original.semantic_judgment } : {}),
      ...(original.mission_admission
        ? {
            mission_admission: original.mission_admission,
            mandate_ref: original.mission_admission.mandate_ref,
            mandate_facts: original.mission_admission.mandate_facts,
          }
        : {}),
      ...(original.continuous_work ? { continuous_work: original.continuous_work } : {}),
      ...(original.information_asset_work
        ? { information_asset_work: original.information_asset_work }
        : {}),
      ...(original.front_desk_execution
        ? { front_desk_execution: original.front_desk_execution }
        : {}),
      ...(original.expected_effect ? { expected_effect: original.expected_effect } : {}),
      ...(original.intent ? { intent: original.intent } : {}),
    },
  };
}

/** Existing claimed/mission facades call this after their current claim/scope fence. */
export function restoreDotWorkItemBodyForSource(item: WorkItem, rootDir?: string): WorkItem {
  if (!item.metadata?.dot_private_body) return item;
  const id = item.metadata.dot_id;
  const source = typeof id === 'string' ? findDotCharter(id, rootDir)?.charter : undefined;
  if (
    !source ||
    source.status !== 'active' ||
    judgmentCanonicalHash(source.scope) !== judgmentCanonicalHash(item.metadata.dot_scope) ||
    source.authority.authority_role !== item.metadata.authority_role
  )
    throw new Error(
      '[DOT_PRIVATE_BODY_UNAVAILABLE] Current original source scope or authority is unavailable'
    );
  return restoreDotWorkItemBody(source, item, rootDir);
}

/** Real stores still verify original history; injected finders must prove this strict projection. */
export function assertDotExistingWorkItem(
  record: DotActionRecord,
  existing: WorkItem | undefined,
  input: ReturnType<typeof dotWorkItemInput>,
  injected: boolean
): void {
  if (!existing) return;
  const privateMarker = existing.metadata?.dot_private_body as
    { semantic_hash?: string; scope_hash?: string } | undefined;
  if (privateMarker) {
    if (
      privateMarker.semantic_hash !== record.admission?.semantic_hash ||
      privateMarker.scope_hash !== record.admission?.scope_hash ||
      existing.metadata?.action_ref !== record.action_ref
    )
      throw new Error('Existing private WorkItem differs from immutable admission');
  }
  if (
    judgmentCanonicalHash(existing.metadata?.information_asset_work ?? null) !==
    judgmentCanonicalHash(record.information_asset_work ?? null)
  )
    throw new Error('Existing WorkItem information asset origin differs from immutable admission');
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
  existing?: { item_id: string; source_ref: string },
  executor: DotCharter = charter
): CreateWorkItemInput & { itemId: string } {
  assertDotActionJudgmentBinding(record);
  const referenceBinding = record.front_desk_execution
    ? parseFrontDeskExecutionBinding(record.front_desk_execution)
    : undefined;
  if (
    record.front_desk_execution &&
    (charter.scope.tier !== 'public' || !referenceBinding || record.semantic_judgment)
  )
    throw new Error(
      '[FRONT_DESK_REFERENCE_SCOPE] Diagnostic receipts require public input and their exact reference-only binding'
    );
  const publicReference = referenceBinding
    ? frontDeskExecutionProposal(referenceBinding)
    : undefined;
  if (publicReference) {
    // This path has its own signed request/approval binding, not generic admission.
    // Only its fixed reference projection may enter the shared WorkItem index.
    record = {
      ...record,
      ...publicReference,
      rationale: undefined,
      expected_effect: undefined,
      mission_admission: undefined,
      admission_only: undefined,
      gate_action_id: undefined,
      continuous_work: undefined,
      information_asset_work: undefined,
      handoff_to: undefined,
    };
  }
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
  const privateBody =
    !publicReference && (charter.scope.tier !== 'public' || Boolean(charter.scope.tenant_slug));
  if (privateBody && !record.admission)
    throw new Error(
      '[DOT_PRIVATE_BODY_UNAVAILABLE] Private work requires its original scoped admission'
    );
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
    title: privateBody ? PRIVATE_WORK_TITLE : record.title,
    description: publicReference
      ? publicReference.objective
      : privateBody
        ? PRIVATE_WORK_DESCRIPTION
        : workItemDescription(charter, record),
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
      dot_scope: { ...charter.scope },
      executor_authority_role: executor.authority.authority_role,
      ...(privateBody
        ? {
            dot_private_body: {
              semantic_hash: record.admission!.semantic_hash,
              scope_hash: record.admission!.scope_hash,
            },
          }
        : {}),
      ...(judgment ? { semantic_judgment: judgment } : {}),
      ...(charter.work_binding ? { operation_id: charter.work_binding.operation_id } : {}),
      ...(record.mission_admission
        ? {
            ...(!privateBody
              ? {
                  mission_admission: record.mission_admission,
                  mandate_facts: record.mission_admission.mandate_facts,
                }
              : {}),
            mandate_ref: record.mission_admission.mandate_ref,
            mission_id: dotAdmissionMissionId(record.action_ref),
          }
        : {}),
      ...(record.admission_only
        ? { admission_only: true, gate_action_id: record.gate_action_id }
        : {}),
      ...(record.continuous_work
        ? { continuous_work: privateBody ? true : record.continuous_work }
        : {}),
      ...(record.information_asset_work
        ? { information_asset_work: record.information_asset_work }
        : {}),
      ...(record.front_desk_execution ? { front_desk_execution: record.front_desk_execution } : {}),
      dot_id: charter.dot_id,
      actor_id: actor,
      action_ref: record.action_ref,
      action_id: record.action_id,
      // Key follows the action schema version so a WorkItem created from a version-1
      // action keeps its original immutable envelope (readers accept both for one release).
      [dotActionRecordSchemaVersion(record) === 1
        ? 'requested_work_shape'
        : 'requested_execution_shape']: record.execution_shape,
      authority_role: charter.authority.authority_role,
      ...(record.decision ? { decision: record.decision } : {}),
      ...(record.request_id ? { approval_request_id: record.request_id } : {}),
      ...(record.handoff_to ? { handoff_to: record.handoff_to } : {}),
      ...(!privateBody && !publicReference && dotGoalRefLabel(charter)
        ? { goal_ref: dotGoalRefLabel(charter) }
        : {}),
      ...(record.pipeline_ref ? { pipeline_ref: record.pipeline_ref } : {}),
      ...(!privateBody && record.expected_effect
        ? { expected_effect: record.expected_effect }
        : {}),
      ...(record.target ? { target: record.target } : {}),
      ...(!privateBody && record.intent ? { intent: record.intent } : {}),
    },
  };
}
