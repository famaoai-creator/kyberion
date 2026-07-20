import type { WisdomAction, PipelineStep } from '../wisdom-pipeline-helpers.js';

const DIRECT_ACTIONS = new Set<WisdomAction['action']>([
  'knowledge_search',
  'history_search',
  'knowledge_inject',
  'knowledge_export',
  'knowledge_import',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertRequiredString(params: Record<string, unknown>, action: string, key: string): void {
  if (typeof params[key] !== 'string' || !params[key].trim()) {
    throw new Error(`[INVALID_PARAMS] ${action} requires params.${key}`);
  }
}

function assertDirectActionParams(action: WisdomAction['action'], params: Record<string, unknown>) {
  switch (action) {
    case 'knowledge_search':
      assertRequiredString(params, action, 'query');
      break;
    case 'knowledge_inject':
      assertRequiredString(params, action, 'knowledge_path');
      assertRequiredString(params, action, 'mission_id');
      break;
    case 'knowledge_export':
      assertRequiredString(params, action, 'path');
      break;
    case 'knowledge_import':
      if (
        (typeof params.package_path !== 'string' || !params.package_path.trim()) &&
        (typeof params.source_path !== 'string' || !params.source_path.trim())
      ) {
        throw new Error(
          `[INVALID_PARAMS] ${action} requires params.package_path or params.source_path`
        );
      }
      break;
    case 'history_search':
      break;
    default:
      break;
  }
}

function assertPipelineStep(step: unknown): asserts step is PipelineStep {
  if (!isRecord(step)) throw new Error('[INVALID_REQUEST] Pipeline step must be an object');
  const type = step.type;
  const op = step.op;
  if (!['capture', 'transform', 'apply', 'control'].includes(String(type))) {
    throw new Error(`[UNKNOWN_TYPE] Unknown wisdom step type: ${String(type)}`);
  }
  if (typeof op !== 'string' || !op) {
    throw new Error('[INVALID_REQUEST] Pipeline step op must be a non-empty string');
  }
  if (type === 'control') {
    if (!['if', 'while'].includes(op)) {
      throw new Error(`[UNKNOWN_OP] Unknown control op: ${op}`);
    }
    return;
  }
}

export function validateWisdomRequest(input: unknown): asserts input is WisdomAction {
  if (!isRecord(input) || typeof input.action !== 'string') {
    throw new Error('[INVALID_REQUEST] Wisdom request requires an action');
  }
  if (DIRECT_ACTIONS.has(input.action as WisdomAction['action'])) {
    if (!isRecord(input.params)) {
      throw new Error(`[INVALID_REQUEST] Direct action ${input.action} requires params`);
    }
    assertDirectActionParams(input.action, input.params);
    return;
  }
  if (input.action === 'pipeline') {
    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      throw new Error('[INVALID_REQUEST] Pipeline requires at least one step');
    }
    for (const step of input.steps) assertPipelineStep(step);
    return;
  }
  if (input.action === 'reconcile') return;
  throw new Error(`[UNKNOWN_OP] Unknown wisdom action: ${input.action}`);
}
