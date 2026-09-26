import { listManagedPlugins, type ManagedPluginRecord } from '@agent/core/plugin-managed-install';
import {
  composePluginViewsA2UI,
  dispatchPluginViewAction,
  executeApprovedPluginViewAction,
  listPluginViewActionRequests,
  listPluginViewsForViewer,
  PluginViewError,
  pluginViewErrorStatus,
  resolvePluginViewAction,
  type LoadedPluginView,
  type PluginViewActionOutcome,
  type PluginViewActionRequestSummary,
  type PluginViewFilter,
  type PluginViewViewer,
} from '@agent/core/plugin-view-contract';
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

export function readVisiblePluginViews(
  viewer: ViewerContext,
  filter: PluginViewFilter,
  listRecords: () => ManagedPluginRecord[] = () => listManagedPlugins()
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

export function buildPluginViewsPayload(
  views: LoadedPluginView[],
  errors: Array<{ pluginId: string; viewId?: string; code: string }>,
  locale: PluginViewLocale,
  actionRequests: PluginViewActionRequestSummary[] = []
) {
  return {
    source_resource: 'plugin-views',
    views: views.map((view) => ({
      plugin_id: view.pluginId,
      view_id: view.declaration.id,
      title_key: view.declaration.titleKey,
      title: pluginViewTitle(view.declaration.titleKey, locale),
      refresh: view.declaration.lifecycle.refresh,
      actions: view.declaration.actions.map((action) => ({
        id: action.id,
        authority: action.authority,
        op: action.op,
      })),
      messages: view.messages,
    })),
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
 * Resolves the requested view among the plugin views visible to the viewer
 * and dispatches the action — or, with `approval_request_id`, executes the
 * approved human action once. A plugin that exists but is not activatable
 * (pending approval, digest mismatch) is 403; a view the viewer cannot see
 * is 404 so its existence is not disclosed.
 */
export async function runPluginViewAction(
  viewer: ViewerContext,
  input: PluginViewActionInput,
  listRecords: () => ManagedPluginRecord[] = () => listManagedPlugins()
): Promise<PluginViewActionOutcome> {
  const scope = viewerForPluginViews(viewer).tenantSlugs;
  const record = listRecords().find(
    (entry) =>
      entry.pluginId === input.plugin_id &&
      // Another tenant's plugin is "not found", whatever its status.
      (!entry.tenantSlug || scope === 'all' || scope.includes(entry.tenantSlug))
  );
  if (record && record.activationStatus !== 'activatable') {
    throw new PluginViewError(
      'PLUGIN_VIEW_DENIED',
      `plugin '${input.plugin_id}' is not activatable (status=${record.activationStatus})`
    );
  }
  const { views } = readVisiblePluginViews(viewer, {}, () => (record ? [record] : []));
  const view = views.find((candidate) => candidate.declaration.id === input.view_id);
  if (!view) {
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
