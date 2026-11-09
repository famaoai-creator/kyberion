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
  fallback: ExecutionShape = 'task_session'
): ExecutionShape {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized && EXECUTION_SHAPE_SET.has(normalized)) {
    return normalized as ExecutionShape;
  }
  return fallback;
}

export function projectExecutionShapeToWorkflowShape(
  shape: ExecutionShape
): WorkflowExecutionShape {
  if (shape === 'actuator_action' || shape === 'browser_session') {
    return 'task_session';
  }
  return shape;
}

/*
 * Named projections of ExecutionShape (concept model v2, D7).
 *
 * ExecutionShape is the only execution vocabulary. The legacy shapes below are
 * derived views kept for existing consumers; derive them here and nowhere else.
 */

/** Legacy four-value shape carried by the intent-resolution contract (`resolution_shape`). */
export const INTENT_RESOLUTION_SHAPE_VALUES = [
  'direct_answer',
  'task_session',
  'mission',
  'project_bootstrap',
] as const;

export type IntentResolutionShape = (typeof INTENT_RESOLUTION_SHAPE_VALUES)[number];

/**
 * Project an execution shape onto the intent-resolution contract's legacy shape.
 * `pipeline`, `actuator_action` and `browser_session` fold into `task_session`;
 * the contract carries the unfolded value separately as `execution_shape`.
 */
export function projectExecutionShapeToIntentResolutionShape(
  shape: ExecutionShape
): IntentResolutionShape {
  if (shape === 'direct_reply') return 'direct_answer';
  if (shape === 'mission' || shape === 'project_bootstrap') return shape;
  return 'task_session';
}

/** Surface route family (`SurfaceIntentResolution.routeFamily`). */
export const ROUTE_FAMILY_VALUES = [
  'direct_reply',
  'browser_session',
  'task_session',
  'mission',
  'pipeline',
] as const;

export type RouteFamily = (typeof ROUTE_FAMILY_VALUES)[number];

/**
 * Project an execution shape onto the surface route family. Shapes without a
 * surface route (`actuator_action`, `project_bootstrap`) project to undefined.
 */
export function projectExecutionShapeToRouteFamily(shape: ExecutionShape): RouteFamily | undefined {
  if (shape === 'actuator_action' || shape === 'project_bootstrap') return undefined;
  return shape;
}

/** Narrow an untrusted string to an ExecutionShape without a fallback. */
export function parseExecutionShape(value: unknown): ExecutionShape | undefined {
  return typeof value === 'string' && EXECUTION_SHAPE_SET.has(value)
    ? (value as ExecutionShape)
    : undefined;
}
