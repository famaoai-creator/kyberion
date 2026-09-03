import { parseSafeJsonObjectValue } from '@agent/core/foundation';

export type BrowserOperatorApprovalStatus = 'pending' | 'approved' | 'expired' | 'rejected';

export interface BrowserOperatorApprovalRecord {
  request_id: string;
  session_id: string;
  status: BrowserOperatorApprovalStatus;
  message: string;
  continue_file: string;
  created_at: string;
  timeout_ms?: number;
  completed_at?: string;
}

function requiredString(
  record: Record<string, unknown>,
  key: keyof BrowserOperatorApprovalRecord,
  label: string
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredTimestamp(
  record: Record<string, unknown>,
  key: 'created_at' | 'completed_at',
  label: string
): string {
  const value = requiredString(record, key, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}.${key} must be a valid timestamp`);
  }
  return value;
}

/** Parse and reconstruct a browser operator approval artifact before it is reused. */
export function parseBrowserOperatorApprovalRecord(
  value: unknown,
  label = 'browser operator approval'
): BrowserOperatorApprovalRecord {
  const record = parseSafeJsonObjectValue(value, label);
  const status = record.status;
  if (
    status !== 'pending' &&
    status !== 'approved' &&
    status !== 'expired' &&
    status !== 'rejected'
  ) {
    throw new Error(`${label}.status must be a valid approval status`);
  }

  const timeoutMs = record.timeout_ms;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw new Error(`${label}.timeout_ms must be a finite non-negative number`);
  }

  const completedAt =
    record.completed_at === undefined
      ? undefined
      : requiredTimestamp(record, 'completed_at', label);

  return {
    request_id: requiredString(record, 'request_id', label),
    session_id: requiredString(record, 'session_id', label),
    status,
    message: requiredString(record, 'message', label),
    continue_file: requiredString(record, 'continue_file', label),
    created_at: requiredTimestamp(record, 'created_at', label),
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
  };
}
