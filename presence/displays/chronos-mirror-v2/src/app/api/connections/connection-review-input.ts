import type { ConnectionReviewAction } from '../../../../lib/connection-review';

const ACTIONS = new Set<ConnectionReviewAction>(['approve', 'hold', 'delete', 'modify']);
const SAFE_BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface ConnectionReviewInput {
  bindingId: string;
  action: ConnectionReviewAction;
  note: string;
  tenant?: string;
}

export function parseConnectionReviewInput(value: Record<string, unknown>): ConnectionReviewInput {
  const unexpected = Object.keys(value).find(
    (key) => !['bindingId', 'action', 'note', 'tenant'].includes(key)
  );
  if (unexpected) throw new Error(`unexpected connection review field: ${unexpected}`);

  const bindingId = value.bindingId;
  if (typeof bindingId !== 'string' || !SAFE_BINDING_ID.test(bindingId.trim())) {
    throw new Error('bindingId must be a safe non-empty string');
  }
  const action = value.action;
  if (typeof action !== 'string' || !ACTIONS.has(action as ConnectionReviewAction)) {
    throw new Error('action must be approve, hold, delete, or modify');
  }
  const note = value.note;
  if (note !== undefined && (typeof note !== 'string' || note.length > 2_000)) {
    throw new Error('note must be a string up to 2000 characters');
  }
  const tenant = value.tenant;
  if (tenant !== undefined && (typeof tenant !== 'string' || tenant.length > 128)) {
    throw new Error('tenant must be a string up to 128 characters');
  }

  return {
    bindingId: bindingId.trim(),
    action: action as ConnectionReviewAction,
    note: note ?? '',
    ...(typeof tenant === 'string' && tenant.trim() ? { tenant: tenant.trim() } : {}),
  };
}
