import { isRecord } from '../foundation/primitives.js';
import {
  INTENT_RESOLUTION_SHAPE_VALUES,
  parseExecutionShape,
  projectExecutionShapeToIntentResolutionShape,
  type ExecutionShape,
  type IntentResolutionShape,
} from '../contracts/execution-shape.js';

export type { IntentResolutionShape } from '../contracts/execution-shape.js';
export type IntentOutcomeKind =
  'answer' | 'artifact' | 'approval_ready_plan' | 'service_change' | 'status_report';
export type IntentAuthorityLevel =
  'autonomous' | 'approval_required' | 'human_clarification_required';
export type IntentNextActionKind = 'request_approval' | 'provide_input' | 'continue';

export interface IntentResolutionNextAction {
  kind: IntentNextActionKind;
  label: string;
  consequence: string;
}

export interface IntentResolutionContract {
  request_id: string;
  normalized_intent: string;
  missing_inputs: string[];
  /** Legacy projection of `execution_shape` (see projectExecutionShapeToIntentResolutionShape). */
  resolution_shape: IntentResolutionShape;
  /**
   * The unfolded ExecutionShape the projection was derived from. Optional only so
   * contracts serialized before it existed still parse; the resolver always sets it.
   */
  execution_shape?: ExecutionShape;
  outcome_kind: IntentOutcomeKind;
  authority_level: IntentAuthorityLevel;
  next_action: IntentResolutionNextAction;
  project_context?: {
    project_id?: string;
    confidence: number;
  };
  rationale: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Parse an intent-resolution contract at an untrusted web or transport boundary. */
export function parseIntentResolutionContract(
  value: unknown
): IntentResolutionContract | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, [
      'request_id',
      'normalized_intent',
      'missing_inputs',
      'resolution_shape',
      'execution_shape',
      'outcome_kind',
      'authority_level',
      'next_action',
      'project_context',
      'rationale',
    ]) ||
    !isNonEmptyString(value.request_id) ||
    !isNonEmptyString(value.normalized_intent) ||
    !Array.isArray(value.missing_inputs) ||
    value.missing_inputs.some((input) => !isNonEmptyString(input)) ||
    !isNonEmptyString(value.rationale)
  ) {
    return undefined;
  }

  const resolutionShapes: readonly IntentResolutionShape[] = INTENT_RESOLUTION_SHAPE_VALUES;
  const outcomeKinds: IntentOutcomeKind[] = [
    'answer',
    'artifact',
    'approval_ready_plan',
    'service_change',
    'status_report',
  ];
  const authorityLevels: IntentAuthorityLevel[] = [
    'autonomous',
    'approval_required',
    'human_clarification_required',
  ];
  const nextActionKinds: IntentNextActionKind[] = ['request_approval', 'provide_input', 'continue'];
  if (
    !resolutionShapes.includes(value.resolution_shape as IntentResolutionShape) ||
    !outcomeKinds.includes(value.outcome_kind as IntentOutcomeKind) ||
    !authorityLevels.includes(value.authority_level as IntentAuthorityLevel) ||
    !isRecord(value.next_action) ||
    !hasOnlyKeys(value.next_action, ['kind', 'label', 'consequence']) ||
    !nextActionKinds.includes(value.next_action.kind as IntentNextActionKind) ||
    !isNonEmptyString(value.next_action.label) ||
    !isNonEmptyString(value.next_action.consequence)
  ) {
    return undefined;
  }

  // A carried execution_shape must be valid and agree with its own projection.
  const executionShape =
    value.execution_shape === undefined ? undefined : parseExecutionShape(value.execution_shape);
  if (
    value.execution_shape !== undefined &&
    (!executionShape ||
      projectExecutionShapeToIntentResolutionShape(executionShape) !== value.resolution_shape)
  ) {
    return undefined;
  }

  let projectContext: IntentResolutionContract['project_context'];
  if (value.project_context !== undefined) {
    if (
      !isRecord(value.project_context) ||
      !hasOnlyKeys(value.project_context, ['project_id', 'confidence']) ||
      (value.project_context.project_id !== undefined &&
        !isNonEmptyString(value.project_context.project_id)) ||
      typeof value.project_context.confidence !== 'number' ||
      !Number.isFinite(value.project_context.confidence) ||
      value.project_context.confidence < 0 ||
      value.project_context.confidence > 1
    ) {
      return undefined;
    }
    projectContext = {
      ...(value.project_context.project_id
        ? { project_id: value.project_context.project_id as string }
        : {}),
      confidence: value.project_context.confidence,
    };
  }

  const resolutionShape = value.resolution_shape as IntentResolutionShape;
  const outcomeKind = value.outcome_kind as IntentOutcomeKind;
  const authorityLevel = value.authority_level as IntentAuthorityLevel;
  const nextActionKind = value.next_action.kind as IntentNextActionKind;

  return {
    request_id: value.request_id,
    normalized_intent: value.normalized_intent,
    missing_inputs: [...value.missing_inputs],
    resolution_shape: resolutionShape,
    ...(executionShape ? { execution_shape: executionShape } : {}),
    outcome_kind: outcomeKind,
    authority_level: authorityLevel,
    next_action: {
      kind: nextActionKind,
      label: value.next_action.label,
      consequence: value.next_action.consequence,
    },
    ...(projectContext ? { project_context: projectContext } : {}),
    rationale: value.rationale,
  };
}
