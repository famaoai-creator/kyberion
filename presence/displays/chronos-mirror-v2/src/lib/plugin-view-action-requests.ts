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
  'unknown',
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
  /** The server can run it now (approved and the approved copy is active there). */
  executable: boolean;
  /** Error code of why an approved request cannot run in the server process. */
  unavailableReason?: string;
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
        executable: entry.executable === true,
        ...(text(entry, 'unavailable_reason')
          ? { unavailableReason: text(entry, 'unavailable_reason') }
          : {}),
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
    case 'unknown':
      return 'accent';
    default:
      return 'neutral';
  }
}

/** Vocabulary key of a request status label (`plugin` domain). */
export function pluginViewActionStatusKey(status: PluginViewActionRequestStatus): string {
  return `view_action_status_${status}`;
}

/**
 * What the request row offers: an Execute button, the not-executable
 * explanation (approved, but the plugin is not active in the server process),
 * or nothing.
 */
export function pluginViewActionRequestControl(
  item: PluginViewActionRequestItem
): 'execute' | 'not_executable' | 'none' {
  if (item.status !== 'approved') return 'none';
  return item.executable ? 'execute' : 'not_executable';
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

/** PH-01: the Chronos plugin host as reported by the plugin-views GET. */
export interface PluginHostSummary {
  enabled: boolean;
  /** Per-plugin state; present for a localadmin viewer only. */
  plugins?: Array<{ pluginId: string; state: string }>;
}

export function parsePluginHostSummary(raw: unknown): PluginHostSummary {
  if (!isRecord(raw) || !isRecord(raw.data) || !isRecord(raw.data.host)) return { enabled: false };
  const host = raw.data.host;
  const enabled = host.enabled === true;
  if (!Array.isArray(host.plugins)) return { enabled };
  const plugins = host.plugins.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const pluginId = text(entry, 'plugin_id');
    const state = text(entry, 'state');
    return pluginId && state ? [{ pluginId, state }] : [];
  });
  return { enabled, plugins };
}

/** Host badge: vocabulary key (`plugin` domain), count and tone. */
export function pluginHostBadges(
  host: PluginHostSummary
): Array<{ key: string; count?: number; tone: 'neutral' | 'success' | 'danger' }> {
  if (!host.enabled) return [{ key: 'host_disabled', tone: 'neutral' }];
  if (!host.plugins) return [{ key: 'host_enabled', tone: 'success' }];
  const active = host.plugins.filter((plugin) => plugin.state === 'active').length;
  const refused = host.plugins.filter(
    (plugin) => plugin.state === 'refused' || plugin.state === 'restart_required'
  ).length;
  return [
    { key: 'host_active', count: active, tone: 'success' },
    ...(refused > 0 ? [{ key: 'host_refused', count: refused, tone: 'danger' as const }] : []),
  ];
}

/**
 * Why an approved request cannot run here (vocabulary key, `plugin` domain):
 * the host is off, the host refused the plugin, or the approved copy is not
 * running yet (reload pending).
 */
export function pluginViewActionUnavailableKey(
  item: PluginViewActionRequestItem,
  host: PluginHostSummary
): string {
  if (!host.enabled) return 'view_action_host_disabled';
  const state = host.plugins?.find((plugin) => plugin.pluginId === item.pluginId)?.state;
  if (state === 'refused' || state === 'restart_required') return 'view_action_plugin_refused';
  if (!item.unavailableReason || item.unavailableReason === 'PLUGIN_VIEW_ACTION_UNAVAILABLE') {
    return 'view_action_reload_pending';
  }
  return `view_error_${item.unavailableReason.replace(/^PLUGIN_VIEW_/u, '').toLowerCase()}`;
}
