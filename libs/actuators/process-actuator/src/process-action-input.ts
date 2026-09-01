import type { RuntimeResourceKind, RuntimeShutdownPolicy } from '@agent/core/runtime-supervisor';
import { isRecord } from '@agent/core/foundation';

export interface ProcessAction {
  action: 'spawn' | 'stop' | 'list' | 'status' | 'list-surfaces' | 'pipeline';
  steps?: unknown[];
  context?: Record<string, unknown>;
  params: {
    resourceId?: string;
    ownerId?: string;
    ownerType?: string;
    kind?: RuntimeResourceKind;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    shutdownPolicy?: RuntimeShutdownPolicy;
    export_as?: string;
  };
}

const PROCESS_ACTIONS = ['spawn', 'stop', 'list', 'status', 'list-surfaces', 'pipeline'] as const;

function isProcessAction(value: unknown): value is ProcessAction['action'] {
  return typeof value === 'string' && PROCESS_ACTIONS.includes(value as ProcessAction['action']);
}

export function parseProcessAction(value: unknown): ProcessAction {
  if (!isRecord(value) || !isProcessAction(value.action)) {
    throw new Error('process action must be an object with a supported action');
  }
  const params = value.params;
  const steps = value.steps;
  const context = value.context;
  let normalizedParams: Record<string, unknown> = {};
  if (params !== undefined) {
    if (!isRecord(params)) throw new Error('process action params must be an object');
    normalizedParams = params;
  }
  let normalizedSteps: unknown[] | undefined;
  if (steps !== undefined) {
    if (!Array.isArray(steps)) throw new Error('process action steps must be an array');
    normalizedSteps = steps;
  }
  let normalizedContext: Record<string, unknown> | undefined;
  if (context !== undefined) {
    if (!isRecord(context)) throw new Error('process action context must be an object');
    normalizedContext = context;
  }
  return {
    action: value.action,
    params: normalizedParams,
    ...(normalizedSteps !== undefined ? { steps: normalizedSteps } : {}),
    ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
  };
}
