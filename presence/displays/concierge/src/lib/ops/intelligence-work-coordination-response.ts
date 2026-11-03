import { isRecord } from '@agent/core/foundation/primitives';

export type ClientWorkCoordinationItem = {
  item_id: string;
  title: string;
  status: string;
  priority: string;
  project_id: string;
  source_ref: string;
  updated_at: string;
  attempt_count: number;
  current_attempt_id?: string;
  current_attempt_status?: string;
  current_attempt_started_at?: string;
  current_attempt_summary?: string;
  blocked_reason?: string;
  failure_reason?: string;
  claimed_by_peer_id?: string;
  claimed_by_user_id?: string;
};

export type ClientWorkCoordinationSummary = {
  total: number;
  backlog: number;
  ready: number;
  inProgress: number;
  blocked: number;
  review: number;
  done: number;
  archived: number;
  runningAttempts: number;
  recentItems: ClientWorkCoordinationItem[];
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseItem(value: unknown): ClientWorkCoordinationItem | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.item_id) ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(value.status) ||
    !nonEmptyString(value.priority) ||
    !nonEmptyString(value.project_id) ||
    !nonEmptyString(value.source_ref) ||
    !nonEmptyString(value.updated_at) ||
    !nonNegativeInteger(value.attempt_count) ||
    !optionalString(value.current_attempt_id) ||
    !optionalString(value.current_attempt_status) ||
    !optionalString(value.current_attempt_started_at) ||
    !optionalString(value.current_attempt_summary) ||
    !optionalString(value.blocked_reason) ||
    !optionalString(value.failure_reason) ||
    !optionalString(value.claimed_by_peer_id) ||
    !optionalString(value.claimed_by_user_id)
  ) {
    return undefined;
  }
  return {
    item_id: value.item_id,
    title: value.title,
    status: value.status,
    priority: value.priority,
    project_id: value.project_id,
    source_ref: value.source_ref,
    updated_at: value.updated_at,
    attempt_count: value.attempt_count,
    ...(value.current_attempt_id !== undefined
      ? { current_attempt_id: value.current_attempt_id }
      : {}),
    ...(value.current_attempt_status !== undefined
      ? { current_attempt_status: value.current_attempt_status }
      : {}),
    ...(value.current_attempt_started_at !== undefined
      ? { current_attempt_started_at: value.current_attempt_started_at }
      : {}),
    ...(value.current_attempt_summary !== undefined
      ? { current_attempt_summary: value.current_attempt_summary }
      : {}),
    ...(value.blocked_reason !== undefined ? { blocked_reason: value.blocked_reason } : {}),
    ...(value.failure_reason !== undefined ? { failure_reason: value.failure_reason } : {}),
    ...(value.claimed_by_peer_id !== undefined
      ? { claimed_by_peer_id: value.claimed_by_peer_id }
      : {}),
    ...(value.claimed_by_user_id !== undefined
      ? { claimed_by_user_id: value.claimed_by_user_id }
      : {}),
  };
}

function parseSummary(value: unknown): ClientWorkCoordinationSummary | undefined {
  if (
    !isRecord(value) ||
    !nonNegativeInteger(value.total) ||
    !nonNegativeInteger(value.backlog) ||
    !nonNegativeInteger(value.ready) ||
    !nonNegativeInteger(value.inProgress) ||
    !nonNegativeInteger(value.blocked) ||
    !nonNegativeInteger(value.review) ||
    !nonNegativeInteger(value.done) ||
    !nonNegativeInteger(value.archived) ||
    !nonNegativeInteger(value.runningAttempts) ||
    !Array.isArray(value.recentItems)
  ) {
    return undefined;
  }
  const recentItems = value.recentItems.map(parseItem);
  if (!recentItems.every((item): item is NonNullable<typeof item> => item !== undefined)) {
    return undefined;
  }
  return {
    total: value.total,
    backlog: value.backlog,
    ready: value.ready,
    inProgress: value.inProgress,
    blocked: value.blocked,
    review: value.review,
    done: value.done,
    archived: value.archived,
    runningAttempts: value.runningAttempts,
    recentItems,
  };
}

export function parseWorkCoordinationResponse(
  value: unknown
): ClientWorkCoordinationSummary | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  return parseSummary(value.workCoordination);
}
