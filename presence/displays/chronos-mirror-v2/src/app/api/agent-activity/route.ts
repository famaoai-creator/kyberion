import { NextRequest, NextResponse } from 'next/server';
import { buildAgentActivityBoard } from '@agent/core/agent-activity-board';
import {
  buildAgentTrackRecords,
  composeOfficeSnapshot,
  deriveProviderPressure,
} from '@agent/core/ce-adoption';
import { listAgentRuntimeSnapshots } from '@agent/core/agent-runtime-supervisor';
import { listWorkItems } from '@agent/core/work-coordination';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const tenant = req.nextUrl.searchParams.get('tenant') || undefined;
  const board = buildAgentActivityBoard({ tenant });
  const trackRecords = buildAgentTrackRecords(listWorkItems({}));
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
  return NextResponse.json({ ok: true, board, office, trackRecords });
}
