import { isRecord } from '@agent/core/foundation/primitives';

/**
 * FU-02: browser-safe parsing of the `action_requests` the plugin-views GET
 * returns (human view actions queued for approval) and the body that
 * executes an approved one.
 */

export const PLUGIN_VIEW_ACTION_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
  'failed',
  'stale',
  'closed',
] as const;

export type PluginViewActionRequestStatus = (typeof PLUGIN_VIEW_ACTION_REQUEST_STATUSES)[number];

export interface PluginViewActionRequestItem {
  approvalRequestId: string;
  pluginId: string;
  viewId: string;
  actionId: string;
  params: Record<string, unknown>;
  status: PluginViewActionRequestStatus;
}

const STATUS_SET = new Set<string>(PLUGIN_VIEW_ACTION_REQUEST_STATUSES);

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parsePluginViewActionRequests(raw: unknown): PluginViewActionRequestItem[] {
  if (!isRecord(raw) || !isRecord(raw.data) || !Array.isArray(raw.data.action_requests)) return [];
  return raw.data.action_requests.flatMap((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.params)) return [];
    const approvalRequestId = text(entry, 'approval_request_id');
    const pluginId = text(entry, 'plugin_id');
    const viewId = text(entry, 'view_id');
    const actionId = text(entry, 'action_id');
    const status = text(entry, 'status');
    if (!approvalRequestId || !pluginId || !viewId || !actionId || !status) return [];
    if (!STATUS_SET.has(status)) return [];
    return [
      {
        approvalRequestId,
        pluginId,
        viewId,
        actionId,
        params: entry.params,
        status: status as PluginViewActionRequestStatus,
      },
    ];
  });
}

export type PluginViewActionRequestTone = 'neutral' | 'accent' | 'info' | 'success' | 'danger';

export function pluginViewActionRequestTone(
  status: PluginViewActionRequestStatus
): PluginViewActionRequestTone {
  switch (status) {
    case 'pending':
      return 'info';
    case 'approved':
      return 'accent';
    case 'executed':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Vocabulary key of a request status label (`plugin` domain). */
export function pluginViewActionStatusKey(status: PluginViewActionRequestStatus): string {
  return `view_action_status_${status}`;
}

/** POST body that executes an approved request once. */
export function pluginViewActionExecuteBody(item: PluginViewActionRequestItem) {
  return {
    plugin_id: item.pluginId,
    view_id: item.viewId,
    action_id: item.actionId,
    params: item.params,
    approval_request_id: item.approvalRequestId,
  };
}
