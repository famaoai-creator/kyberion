import { pathResolver } from '../path-resolver.js';
import { eventScopeMatches, normalizeEventScope, type EventScopeInput } from '../event-scope.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
/** Read-only approval addressing shared by the store and fenced recovery. */
import type { ApprovalRequestRecord } from './approval-store.js';
import { readGovernedArtifactJson } from '../workforce/artifact-store-reader.js';
import { approvalStoreRoots } from './approval-store-paths.js';

const APPROVAL_CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const APPROVAL_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeApprovalChannel(channel: string, label = 'channel'): string {
  const normalized = String(channel || '')
    .trim()
    .toLowerCase();
  if (!normalized || !APPROVAL_CHANNEL_PATTERN.test(normalized)) {
    throw new Error(`[POLICY_VIOLATION] Invalid approval ${label}: ${channel}`);
  }
  return normalized;
}

export function normalizeApprovalRequestId(id: string): string {
  const normalized = String(id || '').trim();
  if (!normalized || !APPROVAL_REQUEST_ID_PATTERN.test(normalized)) {
    throw new Error(`[POLICY_VIOLATION] Invalid approval request id: ${id}`);
  }
  return normalized.toLowerCase();
}

export function approvalRequestsLogicalDir(storageChannel: string): string {
  return `${approvalStoreRoots().coordination}/${normalizeApprovalChannel(storageChannel)}/approvals/requests`;
}

export function approvalRequestLogicalPath(storageChannel: string, id: string): string {
  return `${approvalRequestsLogicalDir(storageChannel)}/${normalizeApprovalRequestId(id)}.json`;
}

export function loadApprovalRequest(
  storageChannel: string,
  id: string
): ApprovalRequestRecord | null {
  return readGovernedArtifactJson<ApprovalRequestRecord>(
    approvalRequestLogicalPath(storageChannel, id)
  );
}

/** Treat a malformed expiry as expired so approval cannot fail open. */
export function isApprovalRequestExpired(
  record: Pick<ApprovalRequestRecord, 'expiresAt'>,
  now = Date.now()
): boolean {
  if (typeof record.expiresAt !== 'string' || record.expiresAt.trim() === '') return false;
  const expiresAt = Date.parse(record.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export function listApprovalRequests(params?: {
  storageChannels?: string[];
  status?: ApprovalRequestRecord['status'] | ApprovalRequestRecord['status'][];
  kind?: ApprovalRequestRecord['kind'] | ApprovalRequestRecord['kind'][];
  scope?: EventScopeInput;
}): ApprovalRequestRecord[] {
  const channelsRoot = pathResolver.resolve(approvalStoreRoots().coordination);
  if (!safeExistsSync(channelsRoot)) return [];

  const statuses = params?.status
    ? new Set(Array.isArray(params.status) ? params.status : [params.status])
    : null;
  const kinds = params?.kind
    ? new Set(Array.isArray(params.kind) ? params.kind : [params.kind])
    : null;
  const requestedScopeKind = params?.scope?.scope_kind;
  const scopeFilter = params?.scope ? normalizeEventScope(params.scope) : undefined;
  const storageChannels = params?.storageChannels?.length
    ? params.storageChannels.map((channel) => normalizeApprovalChannel(channel, 'storage channel'))
    : safeReaddir(channelsRoot).filter((entry) =>
        safeExistsSync(
          pathResolver.resolve(
            approvalRequestsLogicalDir(normalizeApprovalChannel(entry, 'storage channel'))
          )
        )
      );

  const records: ApprovalRequestRecord[] = [];
  for (const storageChannel of storageChannels) {
    const requestsDir = pathResolver.resolve(approvalRequestsLogicalDir(storageChannel));
    if (!safeExistsSync(requestsDir)) continue;
    for (const entry of safeReaddir(requestsDir).filter((item) => item.endsWith('.json'))) {
      const record = loadApprovalRequest(storageChannel, entry.replace(/\.json$/, ''));
      if (!record) continue;
      if (statuses && !statuses.has(record.status)) continue;
      if (kinds && !kinds.has(record.kind)) continue;
      if (scopeFilter) {
        if (record.scope?.tier !== scopeFilter.tier) continue;
        if (
          !eventScopeMatches(record.scope, {
            ...(requestedScopeKind ? { scope_kind: requestedScopeKind } : {}),
            tenant_slug: scopeFilter.tenant_slug,
            organization_id: scopeFilter.organization_id,
            project_id: scopeFilter.project_id,
            mission_id: scopeFilter.mission_id,
            task_id: scopeFilter.task_id,
          })
        )
          continue;
      }
      records.push(record);
    }
  }

  return records.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}
