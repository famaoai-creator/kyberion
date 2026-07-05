import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { collectOperatorHomeSummary } from '@agent/core';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;

  const url = new URL(req.url);
  const budgetUsd = Number(url.searchParams.get('budgetUsd') || '');
  const limit = Number(url.searchParams.get('limit') || 8);

  const summary = collectOperatorHomeSummary({
    budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : undefined,
    since: url.searchParams.get('since') || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 8,
  });

  return NextResponse.json({ summary });
}
