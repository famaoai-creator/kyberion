import { isRecord } from '@agent/core/foundation/primitives';

export type ClientManualDriveAction = {
  action_id: string;
  kind:
    | 'append_entry'
    | 'stream_assistant'
    | 'execute_tool'
    | 'hook'
    | 'sleep'
    | 'apply_pending_write'
    | 'consume_queue_item';
  title: string;
  description?: string;
  operation_id?: string;
  requires_approval?: boolean;
  status: 'ready' | 'awaiting_approval' | 'blocked';
  approval?: ClientManualApproval;
};

export type ClientManualApproval = {
  status: 'approved' | 'pending' | 'denied';
  request_id?: string;
  message?: string;
};

export type ClientManualExecutionStatus =
  'executed' | 'awaiting_approval' | 'blocked' | 'failed' | 'idle';

export type ClientManualCommandState = 'queued' | 'running' | 'completed' | 'cancelled';

export type ClientManualCommandStatusResponse = {
  agentId: string;
  commandId: string;
  state: ClientManualCommandState;
  actionStatus?: ClientManualExecutionStatus;
  action?: ClientManualDriveAction;
  approval?: ClientManualApproval;
  errorCode?: 'manual_drive_command_failed';
  resumesCommandId?: string;
};

export type ClientManualQueuedResponse = {
  agentId: string;
  commandId: string;
  resumesCommandId?: string;
  action?: ClientManualDriveAction;
};

export type ClientManualExecutionResponse = {
  agentId: string;
  status: ClientManualExecutionStatus;
  action?: ClientManualDriveAction;
  approval?: ClientManualApproval;
  errorCode?: 'manual_drive_command_failed';
  correlationId?: string;
};

export type ClientManualCancelResponse = {
  agentId: string;
  commandId: string;
  status: 'cancelled' | 'already_running' | 'already_completed' | 'already_cleared';
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACTION_KINDS = new Set([
  'append_entry',
  'stream_assistant',
  'execute_tool',
  'hook',
  'sleep',
  'apply_pending_write',
  'consume_queue_item',
]);
const ACTION_STATUSES = new Set(['ready', 'awaiting_approval', 'blocked']);
const EXECUTION_STATUSES = new Set(['executed', 'awaiting_approval', 'blocked', 'failed', 'idle']);
const COMMAND_STATES = new Set(['queued', 'running', 'completed', 'cancelled']);
const CANCEL_STATUSES = new Set([
  'cancelled',
  'already_running',
  'already_completed',
  'already_cleared',
]);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function parseApproval(value: unknown): ClientManualApproval | undefined {
  if (
    !isRecord(value) ||
    (value.status !== 'approved' && value.status !== 'pending' && value.status !== 'denied') ||
    !optionalString(value.request_id) ||
    !optionalString(value.message)
  ) {
    return undefined;
  }
  return {
    status: value.status,
    ...(value.request_id !== undefined ? { request_id: value.request_id } : {}),
    ...(value.message !== undefined ? { message: value.message } : {}),
  };
}

function parseAction(value: unknown): ClientManualDriveAction | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !nonEmptyString(value.action_id) ||
    typeof value.kind !== 'string' ||
    !ACTION_KINDS.has(value.kind) ||
    !nonEmptyString(value.title) ||
    !optionalString(value.description) ||
    !optionalString(value.operation_id) ||
    (value.requires_approval !== undefined && typeof value.requires_approval !== 'boolean') ||
    typeof value.status !== 'string' ||
    !ACTION_STATUSES.has(value.status) ||
    (value.approval !== undefined && !parseApproval(value.approval))
  ) {
    return undefined;
  }
  return {
    action_id: value.action_id,
    kind: value.kind as ClientManualDriveAction['kind'],
    title: value.title,
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.operation_id !== undefined ? { operation_id: value.operation_id } : {}),
    ...(value.requires_approval !== undefined
      ? { requires_approval: value.requires_approval }
      : {}),
    status: value.status as ClientManualDriveAction['status'],
    ...(value.approval !== undefined ? { approval: parseApproval(value.approval) } : {}),
  };
}

function baseResponse(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && hasSafeTree(value) ? value : undefined;
}

export function parseManualPeekResponse(
  value: unknown
): { agentId: string; action: ClientManualDriveAction | null } | undefined {
  const response = baseResponse(value);
  if (!response || response.status !== 'ok' || !nonEmptyString(response.agentId)) {
    return undefined;
  }
  const action = parseAction(response.action);
  return action === undefined ? undefined : { agentId: response.agentId, action };
}

export function parseManualCommandStatusResponse(
  value: unknown
): ClientManualCommandStatusResponse | undefined {
  const response = baseResponse(value);
  if (
    !response ||
    !nonEmptyString(response.agentId) ||
    !nonEmptyString(response.commandId) ||
    typeof response.status !== 'string' ||
    !COMMAND_STATES.has(response.status) ||
    (response.actionStatus !== undefined &&
      (typeof response.actionStatus !== 'string' ||
        !EXECUTION_STATUSES.has(response.actionStatus))) ||
    (response.action !== undefined && !parseAction(response.action)) ||
    (response.approval !== undefined && !parseApproval(response.approval)) ||
    (response.errorCode !== undefined && response.errorCode !== 'manual_drive_command_failed') ||
    !optionalString(response.resumesCommandId)
  ) {
    return undefined;
  }
  return {
    agentId: response.agentId,
    commandId: response.commandId,
    state: response.status as ClientManualCommandState,
    ...(response.actionStatus !== undefined
      ? { actionStatus: response.actionStatus as ClientManualExecutionStatus }
      : {}),
    ...(response.action !== undefined ? { action: parseAction(response.action)! } : {}),
    ...(response.approval !== undefined ? { approval: parseApproval(response.approval)! } : {}),
    ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}),
    ...(response.resumesCommandId !== undefined
      ? { resumesCommandId: response.resumesCommandId }
      : {}),
  };
}

export function parseManualQueuedResponse(value: unknown): ClientManualQueuedResponse | undefined {
  const response = baseResponse(value);
  if (
    !response ||
    response.status !== 'queued' ||
    !nonEmptyString(response.agentId) ||
    !nonEmptyString(response.commandId) ||
    (response.action !== undefined && !parseAction(response.action)) ||
    !optionalString(response.resumesCommandId)
  ) {
    return undefined;
  }
  return {
    agentId: response.agentId,
    commandId: response.commandId,
    ...(response.action !== undefined ? { action: parseAction(response.action)! } : {}),
    ...(response.resumesCommandId !== undefined
      ? { resumesCommandId: response.resumesCommandId }
      : {}),
  };
}

export function parseManualExecutionResponse(
  value: unknown
): ClientManualExecutionResponse | undefined {
  const response = baseResponse(value);
  if (
    !response ||
    !nonEmptyString(response.agentId) ||
    typeof response.status !== 'string' ||
    !EXECUTION_STATUSES.has(response.status) ||
    (response.action !== undefined && !parseAction(response.action)) ||
    (response.approval !== undefined && !parseApproval(response.approval)) ||
    (response.errorCode !== undefined && response.errorCode !== 'manual_drive_command_failed') ||
    !optionalString(response.correlationId)
  ) {
    return undefined;
  }
  return {
    agentId: response.agentId,
    status: response.status as ClientManualExecutionStatus,
    ...(response.action !== undefined ? { action: parseAction(response.action)! } : {}),
    ...(response.approval !== undefined ? { approval: parseApproval(response.approval)! } : {}),
    ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}),
    ...(response.correlationId !== undefined ? { correlationId: response.correlationId } : {}),
  };
}

export function parseManualCancelResponse(value: unknown): ClientManualCancelResponse | undefined {
  const response = baseResponse(value);
  if (
    !response ||
    !nonEmptyString(response.agentId) ||
    !nonEmptyString(response.commandId) ||
    typeof response.status !== 'string' ||
    !CANCEL_STATUSES.has(response.status)
  ) {
    return undefined;
  }
  return {
    agentId: response.agentId,
    commandId: response.commandId,
    status: response.status as ClientManualCancelResponse['status'],
  };
}
