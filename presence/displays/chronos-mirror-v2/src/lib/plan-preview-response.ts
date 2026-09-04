import { isRecord } from '@agent/core/foundation/primitives';

export type ClientPlanPreviewAssignment = {
  team_role: string;
  status: 'assigned' | 'unfilled';
  agent_id: string | null;
};

export type ClientPlanPreview = {
  missionId: string;
  requestText: string;
  source: 'llm' | 'fallback';
  confidence: number;
  goal: { summary: string; successCondition: string };
  delivery: {
    mode: 'one_shot' | 'managed_program';
    requiresApproval: boolean;
    clarificationNeeded: boolean;
    askHumanToConfirm: boolean;
    rationale: string;
  };
  execution: {
    shape: 'direct_reply' | 'task_session' | 'pipeline' | 'mission' | 'project_bootstrap';
    taskType?: string;
    requiredInputs: string[];
    missingInputs: string[];
    clarificationQuestions: Array<{
      id: string;
      question: string;
      reason: string;
      default_assumption?: string;
      impact?: string;
    }>;
    recommendedNextStep?: string;
  };
  workflow: Array<{
    id: string;
    label: string;
    description: string;
    actuator: string;
    phase: string;
    requires_confirmation?: boolean;
    input_refs?: string[];
    output_refs?: string[];
  }>;
  team: {
    assignments: ClientPlanPreviewAssignment[];
    team_governance?: { composition: { required_roles: string[] } };
  };
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DELIVERY_MODES = new Set(['one_shot', 'managed_program']);
const EXECUTION_SHAPES = new Set([
  'direct_reply',
  'task_session',
  'pipeline',
  'mission',
  'project_bootstrap',
]);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && Boolean(value.trim());
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function parseClarificationQuestion(
  value: unknown
): ClientPlanPreview['execution']['clarificationQuestions'][number] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.id) ||
    !isString(value.question) ||
    !isString(value.reason) ||
    !isOptionalString(value.default_assumption) ||
    !isOptionalString(value.impact)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    question: value.question,
    reason: value.reason,
    ...(value.default_assumption !== undefined
      ? { default_assumption: value.default_assumption }
      : {}),
    ...(value.impact !== undefined ? { impact: value.impact } : {}),
  };
}

function parseWorkflowStep(value: unknown): ClientPlanPreview['workflow'][number] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.id) ||
    !isString(value.label) ||
    !isString(value.description) ||
    !isString(value.actuator) ||
    !isString(value.phase) ||
    (value.requires_confirmation !== undefined &&
      typeof value.requires_confirmation !== 'boolean') ||
    !isOptionalStringArray(value.input_refs) ||
    !isOptionalStringArray(value.output_refs)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    label: value.label,
    description: value.description,
    actuator: value.actuator,
    phase: value.phase,
    ...(value.requires_confirmation !== undefined
      ? { requires_confirmation: value.requires_confirmation }
      : {}),
    ...(value.input_refs !== undefined ? { input_refs: value.input_refs } : {}),
    ...(value.output_refs !== undefined ? { output_refs: value.output_refs } : {}),
  };
}

function parseAssignment(value: unknown): ClientPlanPreviewAssignment | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.team_role) ||
    (value.status !== 'assigned' && value.status !== 'unfilled') ||
    (value.agent_id !== null && !isString(value.agent_id))
  ) {
    return undefined;
  }
  return {
    team_role: value.team_role,
    status: value.status,
    agent_id: value.agent_id,
  };
}

function parseTeam(value: unknown): ClientPlanPreview['team'] | undefined {
  if (!isRecord(value) || !Array.isArray(value.assignments)) return undefined;
  const assignments = value.assignments.map(parseAssignment);
  if (assignments.some((entry) => !entry)) return undefined;
  if (value.team_governance === undefined) {
    return { assignments: assignments as ClientPlanPreviewAssignment[] };
  }
  if (!isRecord(value.team_governance) || !isRecord(value.team_governance.composition)) {
    return undefined;
  }
  const composition = value.team_governance.composition;
  if (!isStringArray(composition.required_roles)) return undefined;
  return {
    assignments: assignments as ClientPlanPreviewAssignment[],
    team_governance: { composition: { required_roles: composition.required_roles } },
  };
}

function parsePreview(value: unknown): ClientPlanPreview | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.missionId) ||
    !isString(value.requestText) ||
    (value.source !== 'llm' && value.source !== 'fallback') ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !isRecord(value.goal) ||
    !isNonEmptyString(value.goal.summary) ||
    !isString(value.goal.successCondition) ||
    !isRecord(value.delivery) ||
    !isString(value.delivery.mode) ||
    !DELIVERY_MODES.has(value.delivery.mode) ||
    typeof value.delivery.requiresApproval !== 'boolean' ||
    typeof value.delivery.clarificationNeeded !== 'boolean' ||
    typeof value.delivery.askHumanToConfirm !== 'boolean' ||
    !isString(value.delivery.rationale) ||
    !isRecord(value.execution) ||
    !isString(value.execution.shape) ||
    !EXECUTION_SHAPES.has(value.execution.shape) ||
    !isOptionalString(value.execution.taskType) ||
    !isStringArray(value.execution.requiredInputs) ||
    !isStringArray(value.execution.missingInputs) ||
    !Array.isArray(value.execution.clarificationQuestions) ||
    !isOptionalString(value.execution.recommendedNextStep) ||
    !Array.isArray(value.workflow) ||
    !isRecord(value.team)
  ) {
    return undefined;
  }

  const questions = value.execution.clarificationQuestions.map(parseClarificationQuestion);
  const workflow = value.workflow.map(parseWorkflowStep);
  const team = parseTeam(value.team);
  if (questions.some((entry) => !entry) || workflow.some((entry) => !entry) || !team) {
    return undefined;
  }

  return {
    missionId: value.missionId,
    requestText: value.requestText,
    source: value.source,
    confidence: value.confidence,
    goal: { summary: value.goal.summary, successCondition: value.goal.successCondition },
    delivery: {
      mode: value.delivery.mode,
      requiresApproval: value.delivery.requiresApproval,
      clarificationNeeded: value.delivery.clarificationNeeded,
      askHumanToConfirm: value.delivery.askHumanToConfirm,
      rationale: value.delivery.rationale,
    },
    execution: {
      shape: value.execution.shape,
      ...(value.execution.taskType !== undefined ? { taskType: value.execution.taskType } : {}),
      requiredInputs: value.execution.requiredInputs,
      missingInputs: value.execution.missingInputs,
      clarificationQuestions: questions as ClientPlanPreview['execution']['clarificationQuestions'],
      ...(value.execution.recommendedNextStep !== undefined
        ? { recommendedNextStep: value.execution.recommendedNextStep }
        : {}),
    },
    workflow: workflow as ClientPlanPreview['workflow'],
    team,
  };
}

export function parsePlanPreviewResponse(
  value: unknown
): { preview: ClientPlanPreview } | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const preview = parsePreview(value.preview);
  return preview ? { preview } : undefined;
}
