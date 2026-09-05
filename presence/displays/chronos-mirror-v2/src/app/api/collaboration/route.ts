import { NextRequest, NextResponse } from 'next/server';
import { buildAgentCollaborationProjection } from '@agent/core/agent-collaboration-projection';
import { composeCollaborationTree } from '@agent/core/agent-collaboration-tree';
import { normalizeCollaborationLimit } from '../../../lib/collaboration-limit';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
} from '../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../lib/request-input';

export const dynamic = 'force-dynamic';

let collaborationSnapshotRevision = 0;

function nextCollaborationSnapshotRevision(): number {
  collaborationSnapshotRevision = Math.max(collaborationSnapshotRevision + 1, Date.now());
  return collaborationSnapshotRevision;
}

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const limit = normalizeCollaborationLimit(
    readChronosOptionalStringParam(req.nextUrl.searchParams.get('limit'))
  );
  const missionId = readChronosOptionalStringParam(req.nextUrl.searchParams.get('mission'));
  const tenant = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
  const scopeKind = readChronosOptionalStringParam(req.nextUrl.searchParams.get('scope_kind'));
  const allowedScopeKinds = new Set([
    'system',
    'tenant',
    'organization',
    'project',
    'mission',
    'task',
    'session',
  ]);
  const scopeFilter = {
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization'))
      ? {
          organization_id: readChronosOptionalStringParam(
            req.nextUrl.searchParams.get('organization')
          )!,
        }
      : {}),
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('project'))
      ? { project_id: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project'))! }
      : {}),
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('task'))
      ? { task_id: readChronosOptionalStringParam(req.nextUrl.searchParams.get('task'))! }
      : {}),
    ...(readChronosOptionalStringParam(req.nextUrl.searchParams.get('session'))
      ? { session_id: readChronosOptionalStringParam(req.nextUrl.searchParams.get('session'))! }
      : {}),
    ...(scopeKind && allowedScopeKinds.has(scopeKind)
      ? { scope_kind: scopeKind as import('@agent/core/event-scope').EventScopeKind }
      : {}),
  };
  try {
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, tenant);
    const projection = buildAgentCollaborationProjection({
      missionId,
      tenant: tenantSlugs === 'all' || tenantSlugs.length !== 1 ? undefined : tenantSlugs[0],
      tenantSlugs,
      scopeFilter,
      limit,
      // AC-06: a mission-scoped lookup already reads that mission's own
      // worker-event partition regardless of date window (AC-03); widening
      // the recency window here only helps the unscoped "all missions" view
      // keep yesterday's delegations visible past the projection's own
      // 2-day default, matching the terminal-hud's `AGENT_GRAPH_RECENT_DAYS`.
      ...(missionId ? {} : { bounded: { recentDays: 7 } }),
    });
    const tree = composeCollaborationTree(projection, { now: projection.generated_at });
    return NextResponse.json({
      ok: true,
      projection: { ...projection, tree, revision: nextCollaborationSnapshotRevision() },
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
