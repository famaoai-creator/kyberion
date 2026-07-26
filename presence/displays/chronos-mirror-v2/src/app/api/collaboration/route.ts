import { NextRequest, NextResponse } from 'next/server';
import { buildAgentCollaborationProjection } from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;

  const rawLimit = Number(req.nextUrl.searchParams.get('limit') || 100);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 500)) : 100;
  const missionId = req.nextUrl.searchParams.get('mission') || undefined;
  const tenant = req.nextUrl.searchParams.get('tenant') || undefined;
  const projection = buildAgentCollaborationProjection({ missionId, tenant, limit });
  return NextResponse.json({ ok: true, projection });
}
