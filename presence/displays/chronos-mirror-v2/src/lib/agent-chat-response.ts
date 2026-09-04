import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentChatMessage = Record<string, unknown>;

export type ClientAgentChatSuccessResponse = {
  status: 'ok' | 'warning';
  response: string;
  a2ui?: ClientAgentChatMessage[];
  timestamp: string;
  traceId?: string;
  correlationId?: string;
};

export type ClientAgentChatErrorResponse = {
  error?: string;
  errorCode?: string;
  correlationId?: string;
  traceId?: string;
  title?: string;
  body?: string;
  nextAction?: string;
  traceLine?: string;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SUCCESS_STATUSES = new Set(['ok', 'warning']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function nonEmptyString(value: unknown): value is string {
  return string(value) && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || string(value);
}

function parseA2ui(value: unknown): ClientAgentChatMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.every(isRecord) ? value : undefined;
}

export function parseAgentChatSuccessResponse(
  value: unknown
): ClientAgentChatSuccessResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    typeof value.status !== 'string' ||
    !SUCCESS_STATUSES.has(value.status) ||
    !nonEmptyString(value.response) ||
    !nonEmptyString(value.timestamp) ||
    !optionalString(value.traceId) ||
    !optionalString(value.correlationId)
  ) {
    return undefined;
  }
  const a2ui = parseA2ui(value.a2ui);
  if (value.a2ui !== undefined && !a2ui) return undefined;
  return {
    status: value.status as ClientAgentChatSuccessResponse['status'],
    response: value.response,
    ...(a2ui !== undefined ? { a2ui } : {}),
    timestamp: value.timestamp,
    ...(value.traceId !== undefined ? { traceId: value.traceId } : {}),
    ...(value.correlationId !== undefined ? { correlationId: value.correlationId } : {}),
  };
}

export function parseAgentChatErrorResponse(
  value: unknown
): ClientAgentChatErrorResponse | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  if (
    !optionalString(value.error) ||
    !optionalString(value.errorCode) ||
    !optionalString(value.correlationId) ||
    !optionalString(value.traceId) ||
    !optionalString(value.title) ||
    !optionalString(value.body) ||
    !optionalString(value.nextAction) ||
    !optionalString(value.traceLine)
  ) {
    return undefined;
  }
  if (![value.error, value.body, value.title].some(nonEmptyString)) return undefined;
  return {
    ...(value.error !== undefined ? { error: value.error } : {}),
    ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
    ...(value.correlationId !== undefined ? { correlationId: value.correlationId } : {}),
    ...(value.traceId !== undefined ? { traceId: value.traceId } : {}),
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.body !== undefined ? { body: value.body } : {}),
    ...(value.nextAction !== undefined ? { nextAction: value.nextAction } : {}),
    ...(value.traceLine !== undefined ? { traceLine: value.traceLine } : {}),
  };
}
