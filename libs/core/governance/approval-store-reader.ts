import { eventScopeMatches, normalizeEventScope, type EventScopeInput } from '../event-scope.js';
/** Read-only approval addressing shared by the store and fenced recovery. */
import type { ApprovalRequestRecord } from './approval-store.js';
import {
  approvalPartitionsForTenant,
  approvalRequestLogicalPathAt,
  approvalRequestsLogicalDirAt,
  listApprovalChannelsAt,
  listApprovalDirAt,
  listApprovalPartitions,
  locateApprovalRequest,
  readApprovalJsonAt,
  SYSTEM_APPROVAL_PARTITION,
  type ApprovalPartition,
} from './approval-store-location.js';
import { normalizeApprovalChannel } from './approval-store-paths.js';

export {
  normalizeApprovalChannel,
  normalizeApprovalRequestId,
  approvalRequestsLogicalDir,
  approvalRequestLogicalPath,
} from './approval-store-paths.js';

/**
 * Load a request by `(storageChannel, id)` from wherever it lives — the
 * system tree or a tenant partition this process may bind
 * (approval-store-location.ts). A `scope` naming a tenant narrows the
 * partition probe to that tenant.
 */
export function loadApprovalRequest(
  storageChannel: string,
  id: string,
  options: { scope?: EventScopeInput } = {}
): ApprovalRequestRecord | null {
  return locateApprovalRequest(storageChannel, id, options)?.record ?? null;
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

/**
 * List requests across the system tree and every tenant partition this
 * process may bind. A `scope` filter naming a tenant probes only that
 * tenant's partitions (plus the system tree, for legacy records).
 */
export function listApprovalRequests(params?: {
  storageChannels?: string[];
  status?: ApprovalRequestRecord['status'] | ApprovalRequestRecord['status'][];
  kind?: ApprovalRequestRecord['kind'] | ApprovalRequestRecord['kind'][];
  scope?: EventScopeInput;
}): ApprovalRequestRecord[] {
  const statuses = params?.status
    ? new Set(Array.isArray(params.status) ? params.status : [params.status])
    : null;
  const kinds = params?.kind
    ? new Set(Array.isArray(params.kind) ? params.kind : [params.kind])
    : null;
  const requestedScopeKind = params?.scope?.scope_kind;
  const scopeFilter = params?.scope ? normalizeEventScope(params.scope) : undefined;
  const requestedChannels = params?.storageChannels?.length
    ? params.storageChannels.map((channel) => normalizeApprovalChannel(channel, 'storage channel'))
    : undefined;
  const partitions: ApprovalPartition[] = [
    SYSTEM_APPROVAL_PARTITION,
    ...(scopeFilter?.tenant_slug
      ? approvalPartitionsForTenant(scopeFilter.tenant_slug)
      : listApprovalPartitions()),
  ];

  const records: ApprovalRequestRecord[] = [];
  for (const partition of partitions) {
    const storageChannels = requestedChannels ?? listApprovalChannelsAt(partition);
    for (const storageChannel of storageChannels) {
      const requestsDir = approvalRequestsLogicalDirAt(partition, storageChannel);
      for (const entry of listApprovalDirAt(partition, requestsDir).filter((item) =>
        item.endsWith('.json')
      )) {
        const record = readApprovalJsonAt<ApprovalRequestRecord>(
          partition,
          approvalRequestLogicalPathAt(partition, storageChannel, entry.replace(/\.json$/, ''))
        );
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
  }

  return records.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}
