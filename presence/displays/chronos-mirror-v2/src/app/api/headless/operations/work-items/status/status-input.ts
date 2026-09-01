import {
  HEADLESS_WORK_ITEM_STATUSES,
  type HeadlessWorkItemStatus,
} from '../../../../../../lib/headless-projections';

const ALLOWED_FIELDS = new Set(['item_id', 'status']);
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface HeadlessWorkItemStatusInput {
  item_id: string;
  status: HeadlessWorkItemStatus;
}

export function parseHeadlessWorkItemStatusInput(value: unknown): HeadlessWorkItemStatusInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('headless work item status body must be an object');
  }

  const body = value as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) => !ALLOWED_FIELDS.has(key));
  if (unexpected) throw new Error(`unexpected work item status field: ${unexpected}`);

  if (typeof body.item_id !== 'string' || !SAFE_ITEM_ID.test(body.item_id.trim())) {
    throw new Error('item_id must be a safe non-empty string');
  }
  if (
    typeof body.status !== 'string' ||
    !HEADLESS_WORK_ITEM_STATUSES.includes(body.status as HeadlessWorkItemStatus)
  ) {
    throw new Error(`status must be one of: ${HEADLESS_WORK_ITEM_STATUSES.join(', ')}`);
  }

  return {
    item_id: body.item_id.trim(),
    status: body.status as HeadlessWorkItemStatus,
  };
}
