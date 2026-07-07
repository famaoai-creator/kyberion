import { NextRequest, NextResponse } from 'next/server';
import { buildAgentActivityBoard } from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const tenant = req.nextUrl.searchParams.get('tenant') || undefined;
  return NextResponse.json({ ok: true, board: buildAgentActivityBoard({ tenant }) });
}
