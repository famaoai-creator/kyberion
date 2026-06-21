export const EXECUTION_SHAPE_VALUES = [
  'direct_reply',
  'actuator_action',
  'browser_session',
  'task_session',
  'pipeline',
  'mission',
  'project_bootstrap',
] as const;

export type ExecutionShape = (typeof EXECUTION_SHAPE_VALUES)[number];

export const WORKFLOW_EXECUTION_SHAPE_VALUES = [
  'direct_reply',
  'task_session',
  'pipeline',
  'mission',
  'project_bootstrap',
] as const;

export type WorkflowExecutionShape = (typeof WORKFLOW_EXECUTION_SHAPE_VALUES)[number];

const EXECUTION_SHAPE_SET = new Set<string>(EXECUTION_SHAPE_VALUES);

export function normalizeExecutionShape(
  value?: string | null,
  fallback: ExecutionShape = 'task_session',
): ExecutionShape {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized && EXECUTION_SHAPE_SET.has(normalized)) {
    return normalized as ExecutionShape;
  }
  return fallback;
}

export function projectExecutionShapeToWorkflowShape(
  shape: ExecutionShape,
): WorkflowExecutionShape {
  if (shape === 'actuator_action' || shape === 'browser_session') {
    return 'task_session';
  }
  return shape;
}
