import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  DiscussionMissionScopeError,
  resolveDiscussionRequestScope,
} from '../../../../lib/discussion-request-scope';
import {
  discussionRequestScopeDigest,
  discussionRequestActor,
  withDiscussionRequestContext,
} from '../../../../lib/discussion-request-context';
import { resolveViewerContextForRequest, ViewerContextError } from '../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read-only canonical routing resolution BEFORE the client persists a pending mutation.
 * No reservation, provider inspection, file-write probe, room creation or launch.
 * The returned routing is a selector, never an authorization token.
 */
export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'localadmin');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    discussionRequestActor(viewer);
    const params = req.nextUrl.searchParams;
    const scope = {
      ...resolveDiscussionRequestScope(viewer, {
        tenant: params.get('tenant'),
        organization_id: params.get('organization_id'),
        project_id: params.get('project_id'),
        mission_id: params.get('mission_id'),
      }),
      tier: 'confidential' as const,
    };
    const routing = withDiscussionRequestContext(viewer, scope, () => ({
      tenant: scope.tenant_slug!,
      scope_digest: discussionRequestScopeDigest(scope),
      ...(scope.organization_id ? { organization_id: scope.organization_id } : {}),
      ...(scope.project_id ? { project_id: scope.project_id } : {}),
      ...(scope.mission_id ? { mission_id: scope.mission_id } : {}),
    }));
    return NextResponse.json({ ok: true, routing }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status =
      error instanceof ViewerContextError
        ? error.status
        : error instanceof DiscussionMissionScopeError
          ? 404
          : 503;
    return NextResponse.json(
      {
        ok: false,
        error:
          'Select an existing tenant-bound confidential mission visible to this authenticated viewer. Request context could not be confirmed; nothing was submitted.',
      },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
