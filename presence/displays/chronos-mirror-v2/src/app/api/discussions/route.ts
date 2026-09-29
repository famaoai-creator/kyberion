import { NextRequest, NextResponse } from 'next/server';
import { ensureDiscussionRunning } from '@agent/core/discussion/discussion-engine';
import {
  createDiscussionRoom,
  listDiscussionRooms,
  readDiscussionRoom,
} from '@agent/core/discussion/discussion-store';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  isDiscussionVisibleToViewer,
  resolveDiscussionCreateScope,
} from '../../../lib/discussion-access';
import { readChronosJsonObject, readChronosOptionalStringParam } from '../../../lib/request-input';
import { buildMissionHistoryItems } from '../../../lib/su-surface-data';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
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
    const rooms = withViewerExecutionContext(viewer, () => listDiscussionRooms()).filter((room) =>
      isDiscussionVisibleToViewer(viewer, room.scope, requestedTenant)
    );
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
    const missionId = typeof body.mission_id === 'string' ? body.mission_id.trim() : '';
    let missionScope: {
      tenant?: string;
      project?: string;
      mission?: string;
      tier?: 'public' | 'confidential' | 'personal';
    } = {};
    if (missionId) {
      // A room may only attach to a mission the viewer can already see; the
      // mission then supplies the tenant / project of the room's context chain.
      const mission = withViewerExecutionContext(viewer, () =>
        buildMissionHistoryItems({
          missionId,
          tier: 'confidential',
          tenantSlugs: strictViewerScopeTenantSlugs(viewer),
          limit: 1,
        })
      ).find((entry) => entry.missionId.toUpperCase() === missionId.toUpperCase());
      if (!mission) {
        return NextResponse.json(
          { ok: false, error: 'mission not found in your scope' },
          { status: 404 }
        );
      }
      missionScope = {
        tenant: mission.tenantSlug,
        project: mission.projectId,
        mission: mission.missionId,
        tier: mission.tier,
      };
    }
    const scope = resolveDiscussionCreateScope(
      viewer,
      missionScope.tenant ??
        (typeof body.tenant === 'string' ? body.tenant.trim() || undefined : undefined),
      typeof body.organization_id === 'string'
        ? body.organization_id.trim() || undefined
        : undefined,
      missionScope.project ??
        (typeof body.project_id === 'string' ? body.project_id.trim() || undefined : undefined)
    );
    if (missionScope.mission) scope.mission_id = missionScope.mission;
    if (missionScope.tier) scope.tier = missionScope.tier;
    const speaker =
      body.speaker === 'scripted' || body.speaker === 'reasoning' ? body.speaker : 'auto';
    const room = withViewerExecutionContext(viewer, () => {
      const created = createDiscussionRoom({
        goal,
        ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title } : {}),
        scope,
        created_by: viewer.principalId ?? viewer.role,
        config: {
          locale: body.locale === 'en' ? 'en' : 'ja',
          speaker,
          ...(clampNumber(body.max_rounds, 1, 8)
            ? { max_rounds: clampNumber(body.max_rounds, 1, 8)! }
            : {}),
          ...(clampNumber(body.turn_delay_ms, 0, 10_000) !== undefined
            ? { turn_delay_ms: clampNumber(body.turn_delay_ms, 0, 10_000)! }
            : {}),
        },
      });
      // The engine is the room's single owner; it runs detached from this request.
      void ensureDiscussionRunning(created.id);
      return readDiscussionRoom(created.id) ?? created;
    });
    return NextResponse.json({ ok: true, room }, { status: 201 });
  } catch (error) {
    return viewerErrorResponse(error, 400);
  }
}
