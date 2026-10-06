import * as crypto from 'node:crypto';
import { readJsonLines } from '../foundation/json.js';
import { assertSafeRepositoryPath, safeLstat, safeReadFile } from '../secure-io.js';
import { validateWorkItem } from './work-coordination-identity.js';
import type { WorkCoordinationEventType } from './work-coordination-types.js';

/** Retained history must prove absence; forgiving current-state readers cannot. */
export interface UndispatchedWorkItemSelector {
  workItemId: string;
  actionRef: string;
  approvalRequestId: string;
  binding: { request_id: string; work_item_id: string; [key: string]: unknown } | object;
}
export type UndispatchedWorkItemEvidence =
  { ok: true; digest: string } | { ok: false; reason: string };
function evidenceObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function evidenceString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function evidenceTimestamp(value: unknown): boolean {
  return evidenceString(value) && Number.isFinite(Date.parse(value));
}
function strictCoordinationHistory(file: string): { rows: unknown[]; text: string } {
  const resolved = assertSafeRepositoryPath(file, { allowMissingLeaf: false });
  const stat = safeLstat(resolved);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
    throw new Error('evidence ledger must be a bounded regular file');
  const text = String(safeReadFile(resolved, { encoding: 'utf8' }));
  const rows = readJsonLines<unknown>(resolved);
  const after = safeLstat(resolved);
  if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
    throw new Error('coordination evidence changed during read');
  return { rows, text };
}
function validateEvidenceLease(value: unknown): void {
  if (
    !evidenceObject(value) ||
    !['lease_id', 'item_id', 'holder_peer_id', 'purpose'].every((key) =>
      evidenceString(value[key])
    ) ||
    !['active', 'released', 'expired'].includes(String(value.status)) ||
    !['expires_at', 'created_at', 'renewed_at'].every((key) => evidenceTimestamp(value[key])) ||
    (value.released_at !== undefined && !evidenceTimestamp(value.released_at)) ||
    !['holder_user_id', 'idempotency_key', 'previous_lease_id'].every(
      (key) => value[key] === undefined || evidenceString(value[key])
    ) ||
    (value.expected_version !== undefined &&
      (!Number.isSafeInteger(value.expected_version) || (value.expected_version as number) < 1))
  )
    throw new Error('invalid historical lease');
}
const EVIDENCE_EVENT_TYPES: readonly WorkCoordinationEventType[] = [
  'item_imported',
  'item_created',
  'item_updated',
  'item_claimed',
  'item_released',
  'item_handed_off',
  'handoff_written',
  'handoff_consumed',
  'item_blocked',
  'item_unblocked',
  'item_attempt_started',
  'item_attempt_released',
  'item_attempt_completed',
  'item_attempt_blocked',
  'item_attempt_failed',
  'mission_handoff_written',
  'review_requested',
  'external_sync_pulled',
  'external_sync_pushed',
  'conflict_detected',
  'board_created',
  'board_updated',
  'lease_expired',
];
function validateEvidenceEvent(value: unknown): void {
  if (
    !evidenceObject(value) ||
    !evidenceString(value.event_id) ||
    !evidenceTimestamp(value.ts) ||
    !EVIDENCE_EVENT_TYPES.includes(value.event_type as WorkCoordinationEventType) ||
    ![
      'item_id',
      'board_id',
      'lease_id',
      'actor_peer_id',
      'actor_user_id',
      'command_id',
      'idempotency_key',
      'status',
      'note',
    ].every((key) => value[key] === undefined || evidenceString(value[key])) ||
    (value.expected_version !== undefined &&
      (!Number.isSafeInteger(value.expected_version) || (value.expected_version as number) < 0)) ||
    (value.payload !== undefined && !evidenceObject(value.payload))
  )
    throw new Error('invalid historical coordination event');
}

type ValidatedUndispatchedWorkItemSelector = UndispatchedWorkItemSelector & {
  binding: { request_id: string; work_item_id: string };
};

export function isUndispatchedWorkItemSelector(
  input: UndispatchedWorkItemSelector
): input is ValidatedUndispatchedWorkItemSelector {
  return !(
    ![input.workItemId, input.actionRef, input.approvalRequestId].every(evidenceString) ||
    !evidenceObject(input.binding) ||
    !evidenceString(input.binding.request_id) ||
    input.binding.work_item_id !== input.workItemId
  );
}

/** Read only the canonical paths resolved by the coordination facade. */
export function inspectUndispatchedWorkItemHistory(
  input: ValidatedUndispatchedWorkItemSelector,
  paths: { items: string; leases: string; events: string }
): UndispatchedWorkItemEvidence {
  // Inspect every snapshot, not only the latest item, active lease, or recent event.
  // No ensureStore, locks, append, repair, or empty-file creation occurs here.
  const items = strictCoordinationHistory(paths.items);
  const leases = strictCoordinationHistory(paths.leases);
  const events = strictCoordinationHistory(paths.events);
  items.rows.forEach(validateWorkItem);
  leases.rows.forEach(validateEvidenceLease);
  events.rows.forEach(validateEvidenceEvent);
  const identifiers = new Set([
    input.workItemId,
    input.actionRef,
    input.approvalRequestId,
    input.binding.request_id,
  ]);
  const linked = (value: unknown): boolean =>
    typeof value === 'string'
      ? identifiers.has(value)
      : Array.isArray(value)
        ? value.some(linked)
        : evidenceObject(value)
          ? Object.values(value).some(linked)
          : false;
  if ([...items.rows, ...leases.rows, ...events.rows].some(linked))
    return { ok: false, reason: 'historical_dispatch_evidence' };
  return {
    ok: true,
    digest: crypto
      .createHash('sha256')
      .update(JSON.stringify([items.text, leases.text, events.text]))
      .digest('hex'),
  };
}

/** Match only scopes established by the coordination facade's live callback fence. */
export function hasUndispatchedWorkItemEvidenceScope(
  scopes: readonly UndispatchedWorkItemSelector[],
  binding: { request_id: string; work_item_id: string },
  links?: { actionRef: string; approvalRequestId: string }
): boolean {
  return scopes.some(
    (scope) =>
      scope.workItemId === binding.work_item_id &&
      evidenceObject(scope.binding) &&
      scope.binding.request_id === binding.request_id &&
      (!links ||
        (scope.actionRef === links.actionRef &&
          scope.approvalRequestId === links.approvalRequestId))
  );
}
