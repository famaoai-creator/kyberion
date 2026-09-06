import type { WorkItemStatus } from '@agent/core/work-coordination';

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
