import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import { buildMissionHistoryItems } from '../../../../lib/su-surface-data';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;

  const url = new URL(req.url);
  const missions = buildMissionHistoryItems({
    query: url.searchParams.get('query') || undefined,
    status: url.searchParams.get('status') || undefined,
    tier: url.searchParams.get('tier') || undefined,
    tenant: url.searchParams.get('tenant') || undefined,
    kind: url.searchParams.get('kind') || undefined,
    missionId: url.searchParams.get('missionId') || undefined,
    limit: Number(url.searchParams.get('limit') || 24),
  });
  return NextResponse.json({ missions });
}
