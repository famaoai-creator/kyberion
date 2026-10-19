import { NextRequest, NextResponse } from 'next/server';
import { recoverDiscussionRequest } from '@agent/core/discussion/discussion-create-request';
import { guardRequest, requireChronosAccess } from '../../../../../lib/api-guard';
import {
  DiscussionMissionScopeError,
  resolveDiscussionRequestScope,
} from '../../../../../lib/discussion-request-scope';
import {
  assertDiscussionRequestScopeDigest,
  discussionRequestActor,
  withDiscussionRequestContext,
} from '../../../../../lib/discussion-request-context';
import {
  resolveViewerContextForRequest,
  ViewerContextError,
} from '../../../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Exact scoped receipt lookup. No repair, creation, provider claim or engine launch. */
export async function GET(req: NextRequest, context: { params: Promise<{ requestId: string }> }) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'localadmin');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const { requestId } = await context.params;
    const actor = discussionRequestActor(viewer);
    const params = req.nextUrl.searchParams;
    // Original routing hints only narrow current authority. The mission is
    // freshly resolved, so stale or revoked scope cannot disclose a receipt.
    const scope = {
      ...resolveDiscussionRequestScope(viewer, {
        tenant: params.get('tenant'),
        organization_id: params.get('organization_id'),
        project_id: params.get('project_id'),
        mission_id: params.get('mission_id'),
      }),
      tier: 'confidential' as const,
    };
    assertDiscussionRequestScopeDigest(params.get('scope_digest'), scope);
    const result = withDiscussionRequestContext(viewer, scope, () =>
      recoverDiscussionRequest({ request_id: requestId, actor, scope })
    );
    return NextResponse.json(
      { ok: true, request: result.request, ...(result.room ? { room: result.room } : {}) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
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
          'The original request cannot be confirmed in your current scope. Keep its handle and check again; do not resubmit.',
      },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
