import { listManagedPlugins, type ManagedPluginRecord } from '@agent/core/plugin-managed-install';
import {
  composePluginViewsA2UI,
  listPluginViewsForViewer,
  PluginViewError,
  pluginViewErrorStatus,
  resolvePluginViewAction,
  type LoadedPluginView,
  type PluginViewFilter,
  type PluginViewViewer,
} from '@agent/core/plugin-view-contract';
import {
  dispatchPluginViewAction,
  executeApprovedPluginViewAction,
  listPluginViewActionRequests,
  type PluginViewActionOutcome,
  type PluginViewActionRequestSummary,
} from '@agent/core/plugin-view-actions';
import type { PluginHostStatus } from '@agent/core/plugin-host';
import { resolveVocabularyEntry } from '@agent/core/vocabulary-catalog';
import { toSurfaceAuthorizationContext, type ViewerContext } from './viewer-context';

/**
 * EP-05: Chronos projection of plugin-contributed views. Only activatable
 * (digest-verified) managed plugins are read; role / tier / tenant gating is
 * evaluated from the server-resolved viewer and the client filter can only
 * narrow it.
 */

export type PluginViewLocale = 'en' | 'ja';

export function pluginViewLocale(acceptLanguage: string | null | undefined): PluginViewLocale {
  return acceptLanguage?.trim().toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function pluginViewTitle(titleKey: string, locale: PluginViewLocale): string {
  try {
    const entry = resolveVocabularyEntry(titleKey)?.entry;
    return entry?.[locale] || entry?.en || titleKey;
  } catch {
    return titleKey;
  }
}

function viewerForPluginViews(viewer: ViewerContext): PluginViewViewer {
  const context = toSurfaceAuthorizationContext(viewer);
  return {
    role: context.role,
    tierAccess: [...context.tierAccess],
    tenantSlugs: context.tenantSlugs === 'all' ? 'all' : [...context.tenantSlugs],
  };
}

function inViewerScope(tenantSlug: string | undefined, viewer: ViewerContext): boolean {
  const scope = viewerForPluginViews(viewer).tenantSlugs;
  return !tenantSlug || scope === 'all' || scope.includes(tenantSlug);
}

/**
 * Managed records in the viewer's tenant scope. Other tenants' records are
 * dropped by the listing itself, so their managed copies are never digested
 * per request; a viewer scoped to 'all' (localadmin) lists every tenant.
 */
export function listManagedPluginsInViewerScope(viewer: ViewerContext): ManagedPluginRecord[] {
  const scope = viewerForPluginViews(viewer).tenantSlugs;
  return scope === 'all'
    ? listManagedPlugins()
    : listManagedPlugins(undefined, { tenantAllow: scope });
}

export function readVisiblePluginViews(
  viewer: ViewerContext,
  filter: PluginViewFilter,
  listRecords: () => ManagedPluginRecord[] = () => listManagedPluginsInViewerScope(viewer)
) {
  return listPluginViewsForViewer(listRecords(), viewerForPluginViews(viewer), filter);
}

/**
 * FU-02: human action requests of the visible views. Only a viewer who may
 * execute them (localadmin) sees them — they carry the queued params.
 */
export function readVisiblePluginViewActionRequests(
  viewer: ViewerContext,
  views: LoadedPluginView[]
): PluginViewActionRequestSummary[] {
  return viewer.role === 'localadmin' ? listPluginViewActionRequests(views) : [];
}

/** PH-02: same-origin URL of an iframe view document (the frame route). */
export const PLUGIN_VIEW_FRAME_ROUTE = '/api/headless/a2ui/plugin-views/frame';

export function pluginViewFrameUrl(pluginId: string, viewId: string): string {
  const params = new URLSearchParams({ plugin_id: pluginId, view_id: viewId });
  return `${PLUGIN_VIEW_FRAME_ROUTE}?${params.toString()}`;
}

/** Plugin ids whose managed record lies in the viewer's tenant scope. */
export function pluginIdsInViewerScope(
  viewer: ViewerContext,
  listRecords: () => ManagedPluginRecord[] = () => listManagedPluginsInViewerScope(viewer)
): Set<string> {
  return new Set(
    listRecords()
      .filter((record) => inViewerScope(record.tenantSlug, viewer))
      .map((record) => record.pluginId)
  );
}

export interface PluginHostPayload {
  enabled: boolean;
  plugins?: Array<{
    plugin_id: string;
    state: PluginHostStatus['plugins'][number]['state'];
    reason_code: string;
    content_digest_prefix?: string;
  }>;
}

/**
 * PH-01: host visibility. A readonly viewer learns only whether the host is
 * on; a localadmin also sees per-plugin state (codes only), limited to the
 * plugins of their tenant scope.
 */
export function pluginHostPayload(
  status: PluginHostStatus,
  viewer: Pick<ViewerContext, 'role'>,
  pluginIdsInScope: ReadonlySet<string>
): PluginHostPayload {
  if (viewer.role !== 'localadmin') return { enabled: status.enabled };
  return {
    enabled: status.enabled,
    plugins: status.plugins
      .filter((plugin) => pluginIdsInScope.has(plugin.pluginId))
      .map((plugin) => ({
        plugin_id: plugin.pluginId,
        state: plugin.state,
        reason_code: plugin.reasonCode,
        ...(plugin.contentDigestPrefix
          ? { content_digest_prefix: plugin.contentDigestPrefix }
          : {}),
      })),
  };
}

export function buildPluginViewsPayload(
  views: LoadedPluginView[],
  errors: Array<{ pluginId: string; viewId?: string; code: string }>,
  locale: PluginViewLocale,
  actionRequests: PluginViewActionRequestSummary[] = [],
  host: PluginHostPayload = { enabled: false }
) {
  return {
    source_resource: 'plugin-views',
    host,
    views: views.map((view) => {
      const frame = view.declaration.isolation === 'sandboxed-iframe';
      return {
        plugin_id: view.pluginId,
        view_id: view.declaration.id,
        title_key: view.declaration.titleKey,
        title: pluginViewTitle(view.declaration.titleKey, locale),
        refresh: view.declaration.lifecycle.refresh,
        isolation: view.declaration.isolation,
        capabilities: [...view.declaration.capabilities],
        actions: view.declaration.actions.map((action) => ({
          id: action.id,
          authority: action.authority,
          op: action.op,
        })),
        messages: view.messages,
        // The document itself is served by the frame route, never inlined.
        ...(frame ? { frame_url: pluginViewFrameUrl(view.pluginId, view.declaration.id) } : {}),
      };
    }),
    // Codes only: load diagnostics can carry managed-copy paths.
    errors: errors.map((error) => ({
      plugin_id: error.pluginId,
      ...(error.viewId ? { view_id: error.viewId } : {}),
      code: error.code,
    })),
    action_requests: actionRequests.map((request) => ({
      approval_request_id: request.approvalRequestId,
      plugin_id: request.pluginId,
      view_id: request.viewId,
      action_id: request.actionId,
      params: request.params,
      status: request.status,
      requested_at: request.requestedAt,
      // Executable only when the Chronos plugin host runs the approved copy (PH-01).
      executable: request.executable,
      ...(request.unavailableReason ? { unavailable_reason: request.unavailableReason } : {}),
    })),
    a2ui: composePluginViewsA2UI(views, (key) => pluginViewTitle(key, locale)),
  };
}

export interface PluginViewActionInput {
  plugin_id: string;
  view_id: string;
  action_id: string;
  params?: Record<string, unknown>;
  /** FU-02: execute the approved human action instead of queueing it. */
  approval_request_id?: string;
}

const APPROVAL_REQUEST_ID = /^[a-z0-9-]{1,128}$/iu;

export function parsePluginViewActionInput(body: Record<string, unknown>): PluginViewActionInput {
  const allowed = new Set(['plugin_id', 'view_id', 'action_id', 'params', 'approval_request_id']);
  const unknownKey = Object.keys(body).find((key) => !allowed.has(key));
  if (unknownKey)
    throw new PluginViewError('PLUGIN_VIEW_PARAMS_INVALID', `unknown field ${unknownKey}`);
  const text = (key: 'plugin_id' | 'view_id' | 'action_id') => {
    const value = body[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 128) {
      throw new PluginViewError('PLUGIN_VIEW_PARAMS_INVALID', `${key} must be a non-empty string`);
    }
    return value.trim();
  };
  const params = body.params;
  if (
    params !== undefined &&
    (typeof params !== 'object' || params === null || Array.isArray(params))
  ) {
    throw new PluginViewError('PLUGIN_VIEW_PARAMS_INVALID', 'params must be an object');
  }
  const rawApprovalRequestId = body.approval_request_id;
  if (
    rawApprovalRequestId !== undefined &&
    (typeof rawApprovalRequestId !== 'string' || !APPROVAL_REQUEST_ID.test(rawApprovalRequestId))
  ) {
    throw new PluginViewError('PLUGIN_VIEW_PARAMS_INVALID', 'approval_request_id is invalid');
  }
  const approvalRequestId = typeof rawApprovalRequestId === 'string' ? rawApprovalRequestId : '';
  return {
    plugin_id: text('plugin_id'),
    view_id: text('view_id'),
    action_id: text('action_id'),
    ...(params ? { params: params as Record<string, unknown> } : {}),
    ...(approvalRequestId ? { approval_request_id: approvalRequestId } : {}),
  };
}

/**
 * One view among the plugin views visible to the viewer. A plugin that
 * exists in the viewer's tenant scope but is not activatable (pending
 * approval, digest mismatch) is 403; a view the viewer cannot see — also any
 * plugin of another tenant — is 404 so its existence is not disclosed.
 */
export function findVisiblePluginView(
  viewer: ViewerContext,
  pluginId: string,
  viewId: string,
  listRecords: () => ManagedPluginRecord[] = () => listManagedPluginsInViewerScope(viewer)
): LoadedPluginView {
  const record = listRecords().find(
    (entry) =>
      entry.pluginId === pluginId &&
      // Another tenant's plugin is "not found", whatever its status.
      inViewerScope(entry.tenantSlug, viewer)
  );
  if (record && record.activationStatus !== 'activatable') {
    throw new PluginViewError(
      'PLUGIN_VIEW_DENIED',
      `plugin '${pluginId}' is not activatable (status=${record.activationStatus})`
    );
  }
  const { views } = readVisiblePluginViews(viewer, {}, () => (record ? [record] : []));
  const view = views.find((candidate) => candidate.declaration.id === viewId);
  if (!view) {
    throw new PluginViewError(
      'PLUGIN_VIEW_NOT_FOUND',
      `view '${pluginId}/${viewId}' is not available`
    );
  }
  return view;
}

/** PH-02: the validated document of a visible `sandboxed-iframe` view. */
export function readVisiblePluginViewFrame(
  viewer: ViewerContext,
  pluginId: string,
  viewId: string,
  listRecords: () => ManagedPluginRecord[] = () => listManagedPluginsInViewerScope(viewer)
): string {
  const view = findVisiblePluginView(viewer, pluginId, viewId, listRecords);
  if (view.declaration.isolation !== 'sandboxed-iframe' || typeof view.html !== 'string') {
    throw new PluginViewError(
      'PLUGIN_VIEW_NOT_FOUND',
      `view '${pluginId}/${viewId}' has no frame document`
    );
  }
  return view.html;
}

/**
 * Resolves the requested view among the plugin views visible to the viewer
 * (`findVisiblePluginView`) and dispatches the action — or, with
 * `approval_request_id`, executes the approved human action once.
 */
export async function runPluginViewAction(
  viewer: ViewerContext,
  input: PluginViewActionInput,
  listRecords: () => ManagedPluginRecord[] = () => listManagedPluginsInViewerScope(viewer)
): Promise<PluginViewActionOutcome> {
  const view = findVisiblePluginView(viewer, input.plugin_id, input.view_id, listRecords);
  // Plugin ops are process-wide (one host may allow several tenants): an
  // action runs only for a plugin of the viewer's own tenant scope.
  if (!inViewerScope(view.tenantSlug, viewer)) {
    throw new PluginViewError(
      'PLUGIN_VIEW_NOT_FOUND',
      `view '${input.plugin_id}/${input.view_id}' is not available`
    );
  }
  const resolved = resolvePluginViewAction(view, input.action_id, input.params);
  if (input.approval_request_id) {
    return executeApprovedPluginViewAction(resolved, input.approval_request_id, {
      executedBy: viewer.principalId || `chronos:${viewer.role}`,
      actorRole: viewer.role,
      surface: 'chronos',
    });
  }
  return dispatchPluginViewAction(resolved, {
    requestedBy: viewer.principalId || `chronos:${viewer.role}`,
    actorRole: viewer.role,
    surface: 'chronos',
  });
}

export function pluginViewErrorKey(error: PluginViewError): string {
  const suffix = error.code.replace(/^PLUGIN_VIEW_/u, '').toLowerCase();
  return `plugin:view_error_${suffix}`;
}

export { PluginViewError, pluginViewErrorStatus };
