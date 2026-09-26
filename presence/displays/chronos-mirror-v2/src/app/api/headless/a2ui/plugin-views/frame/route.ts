import { NextRequest, NextResponse } from 'next/server';
import { pluginViewFrameResponseHeaders } from '@agent/core/plugin-view-frame';
import { guardRequest, requireChronosAccess } from '../../../../../../lib/api-guard';
import {
  authorizeHeadlessOperation,
  headlessErrorResponse,
} from '../../../../../../lib/headless-response';
import {
  resolveViewerContextForRequest,
  withViewerExecutionContext,
} from '../../../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../../../lib/request-input';
import {
  PluginViewError,
  pluginViewErrorKey,
  pluginViewErrorStatus,
  readVisiblePluginViewFrame,
} from '../../../../../../lib/plugin-views-response';

export const dynamic = 'force-dynamic';

const ID_PARAM = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;

/** Error bodies carry the same lockdown headers as the document itself. */
function frameErrorHeaders(): Record<string, string> {
  const headers = pluginViewFrameResponseHeaders();
  delete headers['Content-Type'];
  return headers;
}

function frameErrorResponse(error: unknown) {
  if (error instanceof PluginViewError) {
    return NextResponse.json(
      { ok: false, error: error.code, error_key: pluginViewErrorKey(error) },
      { status: pluginViewErrorStatus(error.code), headers: frameErrorHeaders() }
    );
  }
  const response = headlessErrorResponse(error);
  for (const [name, value] of Object.entries(frameErrorHeaders())) {
    response.headers.set(name, value);
  }
  return response;
}

function readIdParam(req: NextRequest, name: 'plugin_id' | 'view_id'): string {
  const value = readChronosOptionalStringParam(req.nextUrl.searchParams.get(name));
  if (!value || !ID_PARAM.test(value)) {
    throw new PluginViewError('PLUGIN_VIEW_PARAMS_INVALID', `${name} is invalid`);
  }
  return value;
}

/**
 * PH-02: the document of a `sandboxed-iframe` plugin view, loaded by
 * `PluginViewFrame`. Same authorization as the view listing (the view must
 * be visible to the server-resolved viewer; an invisible view is 404, a
 * tampered / unapproved plugin 403). The response carries exactly
 * `pluginViewFrameResponseHeaders()`: a CSP `sandbox` + deny-by-default
 * policy, so the document runs in an opaque origin even when opened directly.
 */
export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'readonly');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.plugin_view.read', {});
    const pluginId = readIdParam(req, 'plugin_id');
    const viewId = readIdParam(req, 'view_id');
    const html = withViewerExecutionContext(resolvedViewer.context, () =>
      readVisiblePluginViewFrame(resolvedViewer.context, pluginId, viewId)
    );
    return new NextResponse(html, { status: 200, headers: pluginViewFrameResponseHeaders() });
  } catch (error) {
    return frameErrorResponse(error);
  }
}
