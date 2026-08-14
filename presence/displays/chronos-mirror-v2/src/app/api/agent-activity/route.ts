import { NextRequest, NextResponse } from 'next/server';
import { buildAgentActivityBoard } from '@agent/core/agent-activity-board';
import {
  buildAgentTrackRecords,
  composeOfficeSnapshot,
  deriveProviderPressure,
} from '@agent/core/ce-adoption';
import { listAgentRuntimeSnapshots } from '@agent/core/agent-runtime-supervisor';
import { listWorkItems } from '@agent/core/work-coordination';
import { buildWorkVisibilityProjection } from '@agent/core/work-visibility';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
} from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const tenant = req.nextUrl.searchParams.get('tenant') || undefined;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const viewer = resolvedViewer.context;
    const tenantSlugs = strictViewerScopeTenantSlugs(viewer, tenant);
    const filter = tenantSlugs === 'all' ? undefined : tenantSlugs;
    const projection = buildWorkVisibilityProjection({
      items: listWorkItems({ tenantSlugs: filter }),
      viewer: { tenantSlugs },
      scope: 'operations',
      view: 'active',
    });
    const board = buildAgentActivityBoard({
      tenant: tenantSlugs === 'all' || tenantSlugs.length !== 1 ? undefined : tenantSlugs[0],
      tenantSlugs,
    });
    const historyProjection = buildWorkVisibilityProjection({
      items: listWorkItems({ tenantSlugs: filter }),
      viewer: { tenantSlugs },
      scope: 'work_items',
    });
    const trackRecords = buildAgentTrackRecords(historyProjection.items);
    const runtimeByAgent = new Map(
      listAgentRuntimeSnapshots().map((snapshot) => [snapshot.agent.agentId, snapshot])
    );
    const office = composeOfficeSnapshot({
      agents: board.entries.map((entry) => ({
        agent_id: entry.agent_id,
        status: entry.status,
        title: entry.title,
        team_role: entry.team_role,
        mission_id: entry.mission_id,
        latest_event: entry.blockers[0]?.reason,
        pressure: deriveProviderPressure({
          demoted: ['error', 'demoted'].includes(
            runtimeByAgent.get(entry.agent_id)?.agent.status || ''
          ),
        }),
      })),
    });
    return NextResponse.json({
      ok: true,
      scope: 'operations',
      view: 'active',
      projection: {
        counts: projection.counts,
        quality: projection.quality,
        lineage: projection.lineage,
      },
      board,
      office,
      trackRecords,
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
