import { NextRequest, NextResponse } from 'next/server';
import { collectCostSummary } from '../../../lib/su-surface-data';

export function GET(req: NextRequest) {
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
