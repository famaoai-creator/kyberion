import { NextRequest, NextResponse } from 'next/server';
import { inspectDiscussionReadiness } from '@agent/core/discussion/discussion-readiness';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  DiscussionMissionScopeError,
  resolveDiscussionRequestScope,
} from '../../../../lib/discussion-request-scope';
import {
  resolveViewerContextForRequest,
  ViewerContextError,
  withViewerExecutionContext,
} from '../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read-only prerequisites: never create a room or consume its execution claim. */
export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'localadmin');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  const params = req.nextUrl.searchParams;
  const provider = params.get('provider');
  if (provider !== 'claude' && provider !== 'codex')
    return NextResponse.json(
      { ok: false, error: 'Choose a supported Discussion provider.' },
      { status: 400 }
    );
  try {
    const scope = resolveDiscussionRequestScope(viewer, {
      mission_id: params.get('mission_id'),
      tenant: params.get('tenant'),
      organization_id: params.get('organization_id'),
      project_id: params.get('project_id'),
    });
    const readiness = withViewerExecutionContext(viewer, () =>
      inspectDiscussionReadiness(provider, scope)
    );
    return NextResponse.json({ ok: true, readiness }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Fixed messages only: raw policy errors can contain private paths or config.
    const status =
      error instanceof DiscussionMissionScopeError
        ? 404
        : error instanceof ViewerContextError
          ? error.status
          : 503;
    const message =
      status === 404
        ? 'Choose a confidential mission visible in your scope.'
        : status === 403
          ? 'Your current scope does not permit this confidential discussion.'
          : 'Prerequisite inspection is unavailable. Ask the runtime operator to check the configured scope and paths.';
    return NextResponse.json(
      { ok: false, error: message },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
