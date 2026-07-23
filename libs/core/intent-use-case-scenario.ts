import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import type { CompileUserIntentFlowInput, IntentContract } from './intent-contract.js';
import type {
  IntentResolutionCandidate,
  IntentResolutionPacket,
  StandardIntentDefinition,
} from './intent-resolution.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/intent-use-case-scenario.schema.json');

export type IntentUseCaseScenarioStatus = 'ready' | 'needs_clarification' | 'blocked';
export type IntentUseCaseScenarioNextAction =
  | 'execute'
  | 'clarify_inputs'
  | 'confirm_scope'
  | 'request_approval'
  | 'resolve_runtime';

export interface IntentUseCaseScenarioInput {
  input: CompileUserIntentFlowInput;
  packet: IntentResolutionPacket;
  selectedIntent?: StandardIntentDefinition;
  executionBrief: ActuatorExecutionBrief;
  intentContract: IntentContract;
  workLoop: OrganizationWorkLoopSummary;
}

export interface IntentUseCaseScenario {
  kind: 'intent-use-case-scenario';
  schema_version: '1.0.0';
  scenario_id: string;
  source_text: string;
  intent_id: string;
  title: string;
  goal: {
    summary: string;
    success_condition: string;
  };
  actors: {
    primary: string;
    collaborators: string[];
  };
  trigger: {
    utterance: string;
    channel?: string;
  };
  preconditions: string[];
  inputs: Array<{
    id: string;
    required: boolean;
    source: 'user' | 'context' | 'runtime' | 'derived';
    description?: string;
  }>;
  steps: Array<{
    id: string;
    sequence: number;
    action: string;
    owner: 'kyberion' | 'user' | 'external';
    execution_shape?: string;
    requires_approval?: boolean;
  }>;
  outputs: Array<{
    id: string;
    description: string;
  }>;
  success_conditions: string[];
  resolution: {
    execution_shape: string;
    task_type?: string;
    workflow_id?: string;
    workflow_pattern?: string;
  };
  governance: {
    risk_profile: 'low' | 'review_required' | 'approval_required' | 'high_stakes';
    requires_approval: boolean;
    review_mode: 'lean' | 'standard' | 'strict';
    required_gate_ids: string[];
  };
  handoff: {
    status: IntentUseCaseScenarioStatus;
    next_action: IntentUseCaseScenarioNextAction;
    missing_inputs: string[];
    clarification_question_ids: string[];
  };
  confidence: number;
  provenance: {
    resolution_confidence: number;
    resolution_candidates: string[];
  };
}

let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function scenarioId(intentId: string): string {
  const normalized = intentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return `use-case-${normalized || 'unresolved-intent'}`;
}

function inputSource(inputId: string): IntentUseCaseScenario['inputs'][number]['source'] {
  if (/service|binding|project|track|tenant|locale|channel|platform|account/i.test(inputId)) {
    return 'context';
  }
  if (/runtime|engine|provider|command|binary|model/i.test(inputId)) return 'runtime';
  return 'user';
}

function resolutionCandidates(
  candidates: IntentResolutionCandidate[],
  selectedIntentId: string
): string[] {
  return candidates
    .filter((candidate) => candidate.intent_id !== selectedIntentId)
    .slice(0, 3)
    .map((candidate) => candidate.intent_id);
}

function buildInputs(
  input: IntentUseCaseScenarioInput,
  missingInputs: string[]
): IntentUseCaseScenario['inputs'] {
  const intakeRequirements = input.workLoop.process_design.intake_requirements || [];
  const ids = unique([
    ...intakeRequirements,
    ...input.intentContract.required_inputs,
    ...missingInputs,
  ]);
  return ids.map((id) => ({
    id,
    required: true,
    source: inputSource(id),
    ...(missingInputs.includes(id)
      ? { description: 'Required before the governed handoff can proceed.' }
      : {}),
  }));
}

function buildSteps(input: IntentUseCaseScenarioInput): IntentUseCaseScenario['steps'] {
  const plan = input.workLoop.process_design.plan_outline || [];
  if (plan.length > 0) {
    return plan.map((action, index) => ({
      id: `step-${index + 1}`,
      sequence: index + 1,
      action,
      owner: 'kyberion' as const,
      execution_shape: input.intentContract.resolution.execution_shape,
      ...(input.intentContract.approval.requires_approval && index === plan.length - 1
        ? { requires_approval: true }
        : {}),
    }));
  }

  const workflowSteps = input.executionBrief.workflow_steps || [];
  if (workflowSteps.length > 0) {
    return workflowSteps.map((step, index) => ({
      id: step.id || `step-${index + 1}`,
      sequence: index + 1,
      action: step.description || step.label,
      owner: 'kyberion' as const,
      execution_shape: input.intentContract.resolution.execution_shape,
      ...(step.requires_confirmation ? { requires_approval: true } : {}),
    }));
  }

  return [
    {
      id: 'step-1',
      sequence: 1,
      action: 'Resolve the request into a governed result and report the outcome.',
      owner: 'kyberion',
      execution_shape: input.intentContract.resolution.execution_shape,
    },
  ];
}

function buildStatus(
  input: IntentUseCaseScenarioInput,
  missingInputs: string[]
): {
  status: IntentUseCaseScenarioStatus;
  next_action: IntentUseCaseScenarioNextAction;
} {
  if (input.executionBrief.readiness === 'blocked_by_runtime') {
    return { status: 'blocked', next_action: 'resolve_runtime' };
  }
  if (missingInputs.length > 0 || input.intentContract.clarification_needed) {
    return { status: 'needs_clarification', next_action: 'clarify_inputs' };
  }
  if (input.intentContract.approval.requires_approval) {
    return { status: 'ready', next_action: 'request_approval' };
  }
  if (input.workLoop.review_design.review_mode !== 'lean') {
    return { status: 'ready', next_action: 'confirm_scope' };
  }
  return { status: 'ready', next_action: 'execute' };
}

export function buildIntentUseCaseScenario(
  input: IntentUseCaseScenarioInput
): IntentUseCaseScenario {
  const selectedIntentId =
    input.intentContract.intent_id || input.packet.selected_intent_id || 'unresolved-intent';
  const missingInputs = unique([
    ...input.intentContract.required_inputs,
    ...input.executionBrief.missing_inputs,
  ]);
  const state = buildStatus(input, missingInputs);
  const confidenceSignals = [
    input.intentContract.confidence,
    input.executionBrief.confidence,
    input.packet.selected_confidence,
  ].filter((value): value is number => typeof value === 'number' && !Number.isNaN(value));
  const confidence = Math.min(
    1,
    Math.max(0, ...(confidenceSignals.length ? confidenceSignals : [0]))
  );
  const title =
    input.selectedIntent?.description ||
    input.workLoop.intent.label ||
    input.executionBrief.user_facing_summary ||
    input.intentContract.goal.summary;
  const outputIds = unique([
    ...input.intentContract.outcome_ids,
    ...input.executionBrief.deliverables,
  ]);
  const outputs = (outputIds.length > 0 ? outputIds : ['governed_result']).map((id) => ({
    id,
    description:
      id === 'governed_result'
        ? 'Governed response, artifact, or state transition produced by the scenario.'
        : `Governed outcome: ${id}`,
  }));
  const preconditions = unique([
    ...(input.workLoop.process_design.operator_checklist || []),
    ...(input.input.serviceBindings || []).map(
      (binding) => `Service binding available: ${binding}`
    ),
  ]);

  const scenario: IntentUseCaseScenario = {
    kind: 'intent-use-case-scenario',
    schema_version: '1.0.0',
    scenario_id: scenarioId(selectedIntentId),
    source_text: input.input.text,
    intent_id: selectedIntentId,
    title,
    goal: input.intentContract.goal,
    actors: {
      primary:
        input.workLoop.teaming.specialist_label ||
        input.workLoop.teaming.specialist_id ||
        'Kyberion operator',
      collaborators: unique(input.workLoop.teaming.team_roles || []),
    },
    trigger: {
      utterance: input.input.text,
      ...(input.input.channel ? { channel: input.input.channel } : {}),
    },
    preconditions:
      preconditions.length > 0
        ? preconditions
        : ['The request is within the selected governance tier.'],
    inputs: buildInputs(input, missingInputs),
    steps: buildSteps(input),
    outputs,
    success_conditions: [input.intentContract.goal.success_condition],
    resolution: {
      execution_shape:
        input.workLoop.resolution.execution_shape ||
        input.intentContract.resolution.execution_shape,
      ...(input.intentContract.resolution.task_type
        ? { task_type: input.intentContract.resolution.task_type }
        : {}),
      ...(input.workLoop.workflow_design.workflow_id
        ? { workflow_id: input.workLoop.workflow_design.workflow_id }
        : {}),
      ...(input.workLoop.workflow_design.pattern
        ? { workflow_pattern: input.workLoop.workflow_design.pattern }
        : {}),
    },
    governance: {
      risk_profile:
        input.selectedIntent?.risk_profile ||
        (input.intentContract.approval.requires_approval ? 'approval_required' : 'review_required'),
      requires_approval: input.intentContract.approval.requires_approval,
      review_mode: input.workLoop.review_design.review_mode,
      required_gate_ids: unique(input.workLoop.review_design.required_gate_ids || []),
    },
    handoff: {
      ...state,
      missing_inputs: missingInputs,
      clarification_question_ids: (input.executionBrief.clarification_questions || []).map(
        (question) => question.id
      ),
    },
    confidence,
    provenance: {
      resolution_confidence: input.packet.selected_confidence || 0,
      resolution_candidates: resolutionCandidates(input.packet.candidates, selectedIntentId),
    },
  };

  const validate = ensureValidator();
  if (!validate(scenario)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid intent use-case scenario: ${errors}`);
  }
  return scenario;
}

export function validateIntentUseCaseScenario(value: unknown): {
  valid: boolean;
  errors: string[];
  value?: IntentUseCaseScenario;
} {
  const validate = ensureValidator();
  const valid = Boolean(validate(value));
  return {
    valid,
    errors: valid
      ? []
      : (validate.errors || []).map(
          (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
        ),
    value: valid ? (value as IntentUseCaseScenario) : undefined,
  };
}
