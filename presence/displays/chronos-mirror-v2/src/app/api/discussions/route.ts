import { coerceLocale } from '@agent/core/locale-normalize';
import { NextRequest, NextResponse } from 'next/server';
import { ensureDiscussionRunning } from '@agent/core/discussion/discussion-engine';
import {
  createDiscussionRoom,
  listDiscussionRooms,
  readDiscussionRoom,
  DiscussionUserError,
} from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { isDiscussionVisibleToViewer } from '../../../lib/discussion-access';
import { readChronosJsonObject, readChronosOptionalStringParam } from '../../../lib/request-input';
import {
  DiscussionMissionScopeError,
  resolveDiscussionRequestScope,
} from '../../../lib/discussion-request-scope';
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
    const scope = resolveDiscussionRequestScope(viewer, body);
    const executionConfig = readDiscussionExecutionConfig(body);
    if (
      executionConfig.single_pass &&
      executionConfig.speaker !== 'scripted' &&
      executionConfig.provider
    ) {
      const readiness = withViewerExecutionContext(viewer, () =>
        inspectDiscussionReadiness(executionConfig.provider!, scope)
      );
      if (readiness.checks.some((check) => check.status === 'blocked')) {
        return NextResponse.json(
          {
            ok: false,
            error:
              'Discussion prerequisites are blocked. Recheck prerequisites before starting a new brief.',
            readiness,
          },
          { status: 409 }
        );
      }
    }
    const room = withViewerExecutionContext(viewer, () => {
      const created = createDiscussionRoom({
        goal,
        ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
        scope,
        created_by: viewer.principalId ?? viewer.role,
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
      });
      // The engine is the room's single owner; it runs detached from this request.
      void ensureDiscussionRunning(created.id);
      return readDiscussionRoom(created.id) ?? created;
    });
    return NextResponse.json({ ok: true, room }, { status: 201 });
  } catch (error) {
    if (error instanceof DiscussionMissionScopeError)
      return NextResponse.json({ ok: false, error: error.message }, { status: 404 });
    if (error instanceof DiscussionUserError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return viewerErrorResponse(error, 400);
  }
}
