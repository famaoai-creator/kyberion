import { NextRequest, NextResponse } from 'next/server';
import { buildMissionHistoryItems } from '../../../../lib/su-surface-data';

export function GET(req: NextRequest) {
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
