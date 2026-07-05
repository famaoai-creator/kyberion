import { NextRequest, NextResponse } from 'next/server';
import { buildApprovalQueueItems } from '../../../lib/su-surface-data';

export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const approvals = buildApprovalQueueItems({
    query: url.searchParams.get('query') || undefined,
    status: url.searchParams.get('status') || undefined,
    kind: url.searchParams.get('kind') || undefined,
    missionId: url.searchParams.get('missionId') || undefined,
    tenant: url.searchParams.get('tenant') || undefined,
    channel: url.searchParams.get('channel') || undefined,
    limit: Number(url.searchParams.get('limit') || 24),
  });
  return NextResponse.json({ approvals });
}
