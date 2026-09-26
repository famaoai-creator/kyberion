import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../../lib/api-guard';
import {
  authorizeHeadlessOperation,
  headlessEnvelope,
  headlessErrorResponse,
} from '../../../../../lib/headless-response';
import {
  resolveViewerContextForRequest,
  withViewerExecutionContext,
  withViewerExecutionContextAsync,
} from '../../../../../lib/viewer-context';
import {
  readChronosJsonObject,
  readChronosOptionalStringParam,
} from '../../../../../lib/request-input';
import {
  buildPluginViewsPayload,
  parsePluginViewActionInput,
  pluginViewErrorKey,
  PluginViewError,
  pluginViewErrorStatus,
  pluginHostPayload,
  pluginIdsInViewerScope,
  pluginViewLocale,
  readVisiblePluginViewActionRequests,
  readVisiblePluginViews,
  runPluginViewAction,
} from '../../../../../lib/plugin-views-response';
import {
  chronosPluginHostStatus,
  ensureChronosPluginHost,
} from '../../../../../lib/plugin-host-boot';

export const dynamic = 'force-dynamic';

function pluginViewErrorResponse(error: unknown) {
  if (error instanceof PluginViewError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.code,
        error_key: pluginViewErrorKey(error),
      },
      { status: pluginViewErrorStatus(error.code) }
    );
  }
  return headlessErrorResponse(error);
}

/** EP-05: declarative views of approved, digest-verified plugins visible to the viewer. */
export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'readonly');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    ensureChronosPluginHost();
    const tenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    const tier = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tier'));
    // A client tenant/tier is authorized against the viewer and then only narrows.
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.plugin_view.read', {
      tenantSlug: tenant,
      ...(tier ? { tier } : {}),
    });
    const { views, errors, actionRequests, host } = withViewerExecutionContext(
      resolvedViewer.context,
      () => {
        const visible = readVisiblePluginViews(resolvedViewer.context, { tenant, tier });
        return {
          ...visible,
          actionRequests: readVisiblePluginViewActionRequests(
            resolvedViewer.context,
            visible.views
          ),
          host: pluginHostPayload(
            chronosPluginHostStatus(),
            resolvedViewer.context,
            resolvedViewer.context.role === 'localadmin'
              ? pluginIdsInViewerScope(resolvedViewer.context)
              : new Set<string>()
          ),
        };
      }
    );
    return NextResponse.json(
      headlessEnvelope(
        'plugin-views',
        buildPluginViewsPayload(
          views,
          errors,
          pluginViewLocale(req.headers.get('accept-language')),
          actionRequests,
          host
        ),
        resolvedViewer.context
      )
    );
  } catch (error) {
    return pluginViewErrorResponse(error);
  }
}

/**
 * EP-05: invoke a declared view action (`human` authority queues an approval
 * request). FU-02: with `approval_request_id` the approved human action is
 * executed exactly once.
 */
export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'localadmin');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.plugin_view.action');
    const parsedBody = await readChronosJsonObject(req, 'Chronos plugin view action');
    if (parsedBody.ok !== true) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const input = parsePluginViewActionInput(parsedBody.body);
    // PH-01: run against the current approved copy (no stale activation after
    // an approval or re-install).
    const host = ensureChronosPluginHost();
    if (host) await host.syncNow();
    const outcome = await withViewerExecutionContextAsync(resolvedViewer.context, () =>
      runPluginViewAction(resolvedViewer.context, input)
    );
    return NextResponse.json(
      headlessEnvelope(
        'plugin-views',
        {
          operation_id: 'chronos.plugin_view.action',
          outcome,
          message_key:
            outcome.status === 'approval_required'
              ? 'plugin:view_action_approval_required'
              : outcome.status === 'executed'
                ? 'plugin:view_action_executed'
                : 'plugin:view_action_dispatched',
        },
        resolvedViewer.context
      ),
      { status: outcome.status === 'approval_required' ? 202 : 200 }
    );
  } catch (error) {
    return pluginViewErrorResponse(error);
  }
}
