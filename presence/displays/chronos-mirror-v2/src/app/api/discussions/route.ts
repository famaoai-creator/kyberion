import { coerceLocale } from '@agent/core/locale-normalize';
import { NextRequest, NextResponse } from 'next/server';
import { ensureDiscussionRunning } from '@agent/core/discussion/discussion-engine';
import { listDiscussionRooms, DiscussionUserError } from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { isDiscussionVisibleToViewer } from '../../../lib/discussion-access';
import { readChronosJsonObject, readChronosOptionalStringParam } from '../../../lib/request-input';
import {
  DiscussionMissionScopeError,
  resolveDiscussionRequestScope,
} from '../../../lib/discussion-request-scope';
import {
  createDiscussionRequest,
  DiscussionRequestConflictError,
} from '@agent/core/discussion/discussion-create-request';
import {
  assertDiscussionRequestScopeDigest,
  discussionRequestActor,
  withDiscussionRequestContext,
} from '../../../lib/discussion-request-context';
import { inspectDiscussionReadiness } from '@agent/core/discussion/discussion-readiness';
import { readDiscussionExecutionConfig } from '../../../lib/discussion-run-contract';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const requestedTenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    const params = req.nextUrl.searchParams;
    const query = readChronosOptionalStringParam(params.get('q'));
    const mode = readChronosOptionalStringParam(params.get('mode'));
    const rooms = withViewerExecutionContext(viewer, () =>
      listDiscussionRooms({
        ...(query ? { query } : {}),
        archived: readChronosOptionalStringParam(params.get('archived')) === '1',
        ...(mode === 'panel' || mode === 'dialogue' ? { mode } : {}),
      })
    ).filter((room) => isDiscussionVisibleToViewer(viewer, room.scope, requestedTenant));
    return NextResponse.json({ ok: true, rooms, accessRole: viewer.role });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const parsed = await readChronosJsonObject(req, 'Chronos discussions');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    const body = parsed.body;
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (!goal) return NextResponse.json({ ok: false, error: 'goal is required' }, { status: 400 });
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId))
      return NextResponse.json(
        { ok: false, error: 'A valid create request UUID is required.' },
        { status: 400 }
      );
    const actor = discussionRequestActor(viewer);
    const scope = { ...resolveDiscussionRequestScope(viewer, body), tier: 'confidential' as const };
    assertDiscussionRequestScopeDigest(body.scope_digest, scope);
    const executionConfig = readDiscussionExecutionConfig(body);
    const result = withDiscussionRequestContext(viewer, scope, () => {
      const readiness =
        executionConfig.single_pass &&
        executionConfig.speaker !== 'scripted' &&
        executionConfig.provider
          ? inspectDiscussionReadiness(executionConfig.provider, scope)
          : undefined;
      const blocked = readiness?.checks.some((check) => check.status === 'blocked');
      const result = createDiscussionRequest({
        request_id: requestId,
        actor,
        scope,
        input: {
          goal,
          ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
          config: {
            locale: coerceLocale(body.locale, ['en', 'ja'] as const, 'ja'),
            mode: body.mode === 'dialogue' ? 'dialogue' : 'panel',
            ...(clampNumber(body.max_rounds, 1, 8)
              ? { max_rounds: clampNumber(body.max_rounds, 1, 8)! }
              : {}),
            ...(clampNumber(body.turn_delay_ms, 0, 10_000) !== undefined
              ? { turn_delay_ms: clampNumber(body.turn_delay_ms, 0, 10_000)! }
              : {}),
            ...executionConfig,
          },
        },
        ...(blocked ? { rejection: 'prerequisites_blocked' as const } : {}),
      });
      // Only the exclusive original creator may launch. A duplicate or GET
      // never repairs, resumes or launches even if the engine never started.
      if (result.should_start && result.request.status === 'created' && result.room)
        void ensureDiscussionRunning(result.room.id);
      return result;
    });
    return NextResponse.json(
      { ok: true, request: result.request, ...(result.room ? { room: result.room } : {}) },
      {
        status: result.should_start ? 201 : result.request.status === 'unconfirmed' ? 202 : 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (error) {
    if (error instanceof DiscussionRequestConflictError)
      return NextResponse.json(
        {
          ok: false,
          error:
            'This scoped request is already bound to a different intent. Check its original receipt.',
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } }
      );
    if (error instanceof DiscussionMissionScopeError)
      return NextResponse.json({ ok: false, error: error.message }, { status: 404 });
    if (error instanceof DiscussionUserError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return viewerErrorResponse(error, 400);
  }
}
