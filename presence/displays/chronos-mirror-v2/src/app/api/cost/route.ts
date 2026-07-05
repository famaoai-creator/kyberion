import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { collectCostSummary } from '../../../lib/su-surface-data';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;

  const url = new URL(req.url);
  const budget = Number(
    url.searchParams.get('budgetUsd') || process.env.CHRONOS_COST_BUDGET_USD || ''
  );
  const summary = collectCostSummary({
    missionId: url.searchParams.get('missionId') || undefined,
    since: url.searchParams.get('since') || undefined,
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
  });
  return NextResponse.json({ summary });
}
