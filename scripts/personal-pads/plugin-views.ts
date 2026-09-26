/**
 * PH-03: plugin-contributed views on the local pads desk.
 *
 * The desk is a read-only projection: the viewer is `readonly` with only the
 * request's (server-narrowed) tier and the server tenant — never every
 * tenant. Records of other tenants are dropped by the managed listing before
 * any of their files is digested or read. Action references are stripped
 * from the composed A2UI, and `sandboxed-iframe` views are reported as
 * `PLUGIN_VIEW_UNSUPPORTED` (the desk has no frame broker).
 *
 * PH-03b: with `KYBERION_PERSONAL_PADS_PLUGIN_HOST` a pads plugin host keeps
 * the approved plugins active in this process, and `authority: 'agent'`
 * view actions may be dispatched. `authority: 'human'` actions are approved
 * and executed in Chronos only.
 */
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { getRegisteredEnvBool, getRegisteredEnvText } from '@agent/core/foundation';
import { listManagedPlugins, type ManagedPluginRecord } from '@agent/core/plugin-managed-install';
import {
  composePluginViewsA2UI,
  listPluginViewsForViewer,
  PluginViewError,
  resolvePluginViewAction,
  type LoadedPluginView,
  type PluginViewViewer,
  type ResolvedPluginViewAction,
} from '@agent/core/plugin-view-contract';
import {
  dispatchPluginViewAction,
  type PluginViewActionOutcome,
} from '@agent/core/plugin-view-actions';
import {
  createPluginHost,
  getOrCreatePluginHost,
  resolvePluginHostPollMs,
  type PluginHost,
} from '@agent/core/plugin-host';
import { resolveVocabularyEntry } from '@agent/core/vocabulary-catalog';
import { defaultPadLocale } from './i18n.js';

export const PERSONAL_PADS_PLUGIN_VIEWS_SURFACE_ID = 'personal-pads.plugin-views';
export const PERSONAL_PADS_PLUGIN_HOST_SURFACE = 'personal-pads';
/** Message key answered with the 403 for a human-authority action. */
export const PERSONAL_PADS_HUMAN_ACTION_KEY = 'personal_pads:plugin_view_action_in_chronos';

type PadScopeContext = Pick<LocalPadContext, 'scope' | 'viewer_principal'>;
type ComposedPluginViews = ReturnType<typeof composePluginViewsA2UI>;

export interface PadPluginViewSummary {
  plugin_id: string;
  view_id: string;
  title: string;
}

export interface PadPluginViewError {
  plugin_id: string;
  view_id?: string;
  code: string;
}

export interface PadPluginViewsResult {
  a2ui: ComposedPluginViews;
  views: PadPluginViewSummary[];
  /** Codes only: load diagnostics can carry managed-copy paths. */
  errors: PadPluginViewError[];
}

export interface PadPluginViewsOptions {
  /** Managed-plugins root override (tests). */
  managedRoot?: string;
  listRecords?: (viewer: PluginViewViewer) => ManagedPluginRecord[];
}

/** Read-only viewer of the request scope: its one tier and the server tenant only. */
export function padPluginViewViewer(context: Pick<LocalPadContext, 'scope'>): PluginViewViewer {
  const tenant = context.scope.tenant_slug;
  return {
    role: 'readonly',
    tierAccess: [context.scope.tier],
    tenantSlugs: tenant ? [tenant] : [],
  };
}

function viewerTenants(viewer: PluginViewViewer): string[] {
  return viewer.tenantSlugs === 'all' ? [] : [...viewer.tenantSlugs];
}

function listScopedRecords(
  viewer: PluginViewViewer,
  options: PadPluginViewsOptions
): ManagedPluginRecord[] {
  if (options.listRecords) return options.listRecords(viewer);
  return listManagedPlugins(options.managedRoot, { tenantAllow: viewerTenants(viewer) });
}

function pluginViewTitle(titleKey: string, locale: SupportedLocale): string {
  try {
    const entry = resolveVocabularyEntry(titleKey)?.entry as Record<string, unknown> | undefined;
    const text = entry?.[locale] ?? entry?.en;
    return typeof text === 'string' && text ? text : titleKey;
  } catch {
    return titleKey;
  }
}

function isActionKey(key: string): boolean {
  return key === 'action' || key.endsWith('_action') || key.endsWith('Action');
}

/** Drops every action reference (same key rule as the view contract). */
function stripActionRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripActionRefs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isActionKey(key))
      .map(([key, nested]) => [key, stripActionRefs(nested)])
  );
}

const isFrameView = (view: LoadedPluginView) => view.declaration.isolation === 'sandboxed-iframe';

/** Default `PersonalPadsSurface.getPluginViews`. */
export function getPadPluginViews(
  context: PadScopeContext,
  locale?: SupportedLocale,
  options: PadPluginViewsOptions = {}
): PadPluginViewsResult {
  const resolved = defaultPadLocale(locale);
  const viewer = padPluginViewViewer(context);
  const { views, errors } = listPluginViewsForViewer(listScopedRecords(viewer, options), viewer);
  const composable = views.filter((view) => !isFrameView(view));
  const composed = composePluginViewsA2UI(
    composable,
    (key) => pluginViewTitle(key, resolved),
    PERSONAL_PADS_PLUGIN_VIEWS_SURFACE_ID
  );
  return {
    a2ui: {
      updateComponents: {
        ...composed.updateComponents,
        components: composed.updateComponents.components.map(
          (component) => stripActionRefs(component) as typeof component
        ),
      },
    },
    views: composable.map((view) => ({
      plugin_id: view.pluginId,
      view_id: view.declaration.id,
      title: pluginViewTitle(view.declaration.titleKey, resolved),
    })),
    errors: [
      ...errors.map((error) => ({
        plugin_id: error.pluginId,
        ...(error.viewId ? { view_id: error.viewId } : {}),
        code: error.code,
      })),
      ...views.filter(isFrameView).map((view) => ({
        plugin_id: view.pluginId,
        view_id: view.declaration.id,
        code: 'PLUGIN_VIEW_UNSUPPORTED',
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// PH-03b: agent-authority actions through the pads plugin host
// ---------------------------------------------------------------------------

type EnvSource = Record<string, string | undefined>;

export function isPadsPluginHostEnabled(env?: EnvSource): boolean {
  return (
    getRegisteredEnvBool('KYBERION_PERSONAL_PADS_PLUGIN_HOST', { env, defaultValue: false }) ===
    true
  );
}

/**
 * Returns the started pads plugin host (one per process), or null when
 * `KYBERION_PERSONAL_PADS_PLUGIN_HOST` is off. Tenant-bound plugins run only
 * for the desk's server tenant.
 */
export function ensurePadsPluginHost(
  base: Pick<LocalPadContext, 'scope'>,
  options: { env?: EnvSource; create?: typeof createPluginHost } = {}
): PluginHost | null {
  if (!isPadsPluginHostEnabled(options.env)) return null;
  const create = options.create ?? createPluginHost;
  return getOrCreatePluginHost(PERSONAL_PADS_PLUGIN_HOST_SURFACE, () => {
    const host = create({
      surface: PERSONAL_PADS_PLUGIN_HOST_SURFACE,
      enabled: true,
      tenantAllow: viewerTenants(padPluginViewViewer(base)),
      pollMs: resolvePluginHostPollMs(
        getRegisteredEnvText('KYBERION_PLUGIN_HOST_POLL_MS', { env: options.env })
      ),
    });
    host.start();
    return host;
  });
}

export interface PadPluginViewActionInput {
  plugin_id: string;
  view_id: string;
  action_id: string;
  params?: Record<string, unknown>;
}

/** A view error with the vocabulary key the desk answers. */
export class PadPluginViewActionError extends PluginViewError {
  constructor(
    code: ConstructorParameters<typeof PluginViewError>[0],
    message: string,
    public readonly messageKey: string
  ) {
    super(code, message);
    this.name = 'PadPluginViewActionError';
  }
}

export function pluginViewErrorMessageKey(error: PluginViewError): string {
  if (error instanceof PadPluginViewActionError) return error.messageKey;
  return `plugin:view_error_${error.code.replace(/^PLUGIN_VIEW_/u, '').toLowerCase()}`;
}

export function parsePadPluginViewActionInput(
  body: Record<string, unknown>
): PadPluginViewActionInput {
  const allowed = new Set(['plugin_id', 'view_id', 'action_id', 'params']);
  const unknownKey = Object.keys(body).find((key) => !allowed.has(key));
  if (unknownKey) {
    throw new PluginViewError('PLUGIN_VIEW_PARAMS_INVALID', `unknown field ${unknownKey}`);
  }
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
  return {
    plugin_id: text('plugin_id'),
    view_id: text('view_id'),
    action_id: text('action_id'),
    ...(params ? { params: params as Record<string, unknown> } : {}),
  };
}

function resolveVisibleAction(
  context: PadScopeContext,
  input: PadPluginViewActionInput,
  options: PadPluginViewsOptions
): ResolvedPluginViewAction {
  const viewer = padPluginViewViewer(context);
  const record = listScopedRecords(viewer, options).find(
    (entry) => entry.pluginId === input.plugin_id
  );
  if (record && record.activationStatus !== 'activatable') {
    throw new PluginViewError(
      'PLUGIN_VIEW_DENIED',
      `plugin '${input.plugin_id}' is not activatable (status=${record.activationStatus})`
    );
  }
  const view = listPluginViewsForViewer(record ? [record] : [], viewer).views.find(
    (candidate) => candidate.declaration.id === input.view_id && !isFrameView(candidate)
  );
  if (!view) {
    throw new PluginViewError(
      'PLUGIN_VIEW_NOT_FOUND',
      `view '${input.plugin_id}/${input.view_id}' is not available`
    );
  }
  return resolvePluginViewAction(view, input.action_id, input.params);
}

/**
 * Dispatches an `authority: 'agent'` view action of a view visible to the
 * request scope. Human actions are refused (they are approved in Chronos);
 * without a pads plugin host nothing runs in this process, so the action is
 * unavailable. The host is synced once before dispatching.
 */
export async function runPadPluginViewAction(
  context: PadScopeContext,
  input: PadPluginViewActionInput,
  host: PluginHost | null,
  options: PadPluginViewsOptions = {}
): Promise<PluginViewActionOutcome> {
  const requested = resolveVisibleAction(context, input, options);
  if (requested.action.authority !== 'agent') {
    throw new PadPluginViewActionError(
      'PLUGIN_VIEW_ACTION_DENIED',
      `action '${input.action_id}' needs a human approval in Chronos`,
      PERSONAL_PADS_HUMAN_ACTION_KEY
    );
  }
  if (!host) {
    throw new PadPluginViewActionError(
      'PLUGIN_VIEW_ACTION_UNAVAILABLE',
      'the pads plugin host is disabled',
      'plugin:view_action_host_disabled'
    );
  }
  await host.syncNow();
  const resolved = resolveVisibleAction(context, input, options);
  return dispatchPluginViewAction(resolved, {
    requestedBy: context.viewer_principal,
    actorRole: 'readonly',
    surface: 'api',
  });
}
