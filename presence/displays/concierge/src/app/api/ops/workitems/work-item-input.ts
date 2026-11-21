import type { WorkItemStatus } from '@agent/core/workforce/work-coordination';

export const CHRONOS_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
  'archived',
];

const ALLOWED_FIELDS = new Set(['itemId', 'status']);
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface WorkItemStatusInput {
  itemId: string;
  status: WorkItemStatus;
}

export function parseWorkItemStatusInput(value: unknown): WorkItemStatusInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('work item status body must be an object');
  }

  const body = value as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) => !ALLOWED_FIELDS.has(key));
  if (unexpected) throw new Error(`unexpected work item status field: ${unexpected}`);

  if (typeof body.itemId !== 'string' || !SAFE_ITEM_ID.test(body.itemId.trim())) {
    throw new Error('itemId must be a safe non-empty string');
  }
  if (
    typeof body.status !== 'string' ||
    !CHRONOS_WORK_ITEM_STATUSES.includes(body.status as WorkItemStatus)
  ) {
    throw new Error(`status must be one of: ${CHRONOS_WORK_ITEM_STATUSES.join(', ')}`);
  }

  return { itemId: body.itemId.trim(), status: body.status as WorkItemStatus };
}

const SCHEDULE_FIELDS = new Set(['itemId', 'startDate', 'dueDate']);
/** Shape only; the store checks that it is a real calendar day. */
const SHORT_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A date change: each date is a `YYYY-MM-DD` string to set, `null` to clear,
 * absent to keep. The store validates the calendar day and start <= due
 * (`work-item-schedule.ts`); its refusal reaches the caller as a 400.
 */
export interface WorkItemScheduleInput {
  itemId: string;
  startDate?: string | null;
  dueDate?: string | null;
}

function isScheduleBody(body: Record<string, unknown>): boolean {
  return 'startDate' in body || 'dueDate' in body;
}

export function parseWorkItemScheduleInput(value: unknown): WorkItemScheduleInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('work item schedule body must be an object');
  }
  const body = value as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) => !SCHEDULE_FIELDS.has(key));
  if (unexpected) throw new Error(`unexpected work item schedule field: ${unexpected}`);
  if (typeof body.itemId !== 'string' || !SAFE_ITEM_ID.test(body.itemId.trim())) {
    throw new Error('itemId must be a safe non-empty string');
  }
  if (!isScheduleBody(body)) throw new Error('startDate or dueDate is required');
  const input: WorkItemScheduleInput = { itemId: body.itemId.trim() };
  for (const field of ['startDate', 'dueDate'] as const) {
    if (!(field in body)) continue;
    const date = body[field];
    if (date !== null && (typeof date !== 'string' || !SHORT_DATE.test(date))) {
      throw new Error(`${field} must be a YYYY-MM-DD string or null`);
    }
    input[field] = date as string | null;
  }
  return input;
}

export type WorkItemActionInput =
  | WorkItemStatusInput
  | WorkItemScheduleInput
  | { itemId: string; action: 'request_mission_alignment' };
/** Explicit action, never an inferred status change or client-supplied scope. */
export function parseWorkItemActionInput(value: unknown): WorkItemActionInput {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'action' in value) {
    const body = value as Record<string, unknown>;
    if (
      Object.keys(body).some((key) => !['itemId', 'action'].includes(key)) ||
      body.action !== 'request_mission_alignment' ||
      typeof body.itemId !== 'string' ||
      !SAFE_ITEM_ID.test(body.itemId.trim())
    )
      throw new Error('invalid work item alignment action');
    return { itemId: body.itemId.trim(), action: 'request_mission_alignment' };
  }
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isScheduleBody(value as Record<string, unknown>)
  )
    return parseWorkItemScheduleInput(value);
  return parseWorkItemStatusInput(value);
}
