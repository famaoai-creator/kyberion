import {
  ProjectIdentity,
  FinancialMetrics,
  StrategicAction,
} from '@agent/core/shared-business-types';

export interface CustomerSegment extends ProjectIdentity, FinancialMetrics {
  monthly_price?: number;
  customer_count?: number;
}

export interface SegmentAnalysis extends FinancialMetrics {
  name: string;
  monthlyPrice: number;
  customerCount: number;
  avgLifetimeMonths: number;
  ltvCacRatio: number;
  monthsToRecoverCAC: number;
  health: 'healthy' | 'at_risk' | 'unprofitable';
  monthlyRevenue: number;
}

/**
 * Unit economics recommendation, compliant with shared StrategicAction.
 */
export interface Recommendation extends StrategicAction {
  segment: string;
}

export interface UnitEconomicsResult {
  source?: string;
  portfolio: {
    totalMRR: number;
    totalARR: number;
    weightedLtvCacRatio: number;
    segmentCount: number;
  };
  segments: SegmentAnalysis[];
  recommendations: Recommendation[];
}

export function calculateLTV(segment: CustomerSegment): number {
  const rawChurn = segment.churnRate !== undefined ? segment.churnRate : 0.05;
  const churn = Math.max(0.001, rawChurn); // Cap churn at 0.1% min to prevent infinity
  const avgLifetimeMonths = 1 / churn;
  const monthlyRevenue = Math.max(0, segment.monthly_price || 0);
  const grossMargin = Math.max(
    0,
    Math.min(1, segment.grossMargin !== undefined ? segment.grossMargin : 0.8)
  );
  return Math.round(monthlyRevenue * grossMargin * avgLifetimeMonths);
}

export function analyzeSegment(segment: CustomerSegment): SegmentAnalysis {
  const ltv = calculateLTV(segment);
  const cac = Math.max(0, segment.cac || 0);
  const ltvCacRatio = cac > 0 ? Math.round((ltv / cac) * 100) / 100 : ltv > 0 ? 99.9 : 0;
  const rawChurn = segment.churnRate !== undefined ? segment.churnRate : 0.05;
  const churn = Math.max(0.001, rawChurn);
  const avgLifetimeMonths = Math.round(1 / churn);

  const monthlyContributionMargin = (segment.monthly_price || 0) * (segment.grossMargin || 0.8);
  const monthsToRecoverCAC =
    cac > 0 && monthlyContributionMargin > 0 ? Math.ceil(cac / monthlyContributionMargin) : 0;

  let health: SegmentAnalysis['health'] = 'healthy';
  if (ltvCacRatio < 1) health = 'unprofitable';
  else if (ltvCacRatio < 3) health = 'at_risk';

  return {
    name: segment.name,
    monthlyPrice: segment.monthly_price || 0,
    customerCount: segment.customer_count || 0,
    churnRate: churn,
    avgLifetimeMonths,
    ltv,
    cac,
    ltvCacRatio,
    monthsToRecoverCAC,
    health,
    monthlyRevenue: Math.round((segment.monthly_price || 0) * (segment.customer_count || 0)),
  };
}

export function generateRecommendations(analyses: SegmentAnalysis[]): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const seg of analyses) {
    if (seg.health === 'unprofitable') {
      recs.push({
        segment: seg.name,
        priority: 'critical',
        action: `LTV/CAC ratio is ${seg.ltvCacRatio} (<1). Consider raising prices, reducing CAC, or discontinuing segment.`,
        area: 'Unit Economics',
      });
    }
    if (seg.health === 'at_risk') {
      recs.push({
        segment: seg.name,
        priority: 'high',
        action: `LTV/CAC ratio is ${seg.ltvCacRatio} (<3). Target ratio of 3+. Focus on reducing churn or lowering acquisition cost.`,
        area: 'Unit Economics',
      });
    }
    if (seg.churnRate! > 0.05) {
      recs.push({
        segment: seg.name,
        priority: 'high',
        action: `Monthly churn ${Math.round(seg.churnRate! * 100)}% exceeds 5% threshold. Investigate with customer exit surveys and improve onboarding.`,
        area: 'Retention',
      });
    }
    if (seg.monthsToRecoverCAC > 12) {
      recs.push({
        segment: seg.name,
        priority: 'medium',
        action: `CAC payback period is ${seg.monthsToRecoverCAC} months. Target <12 months. Review marketing spend efficiency.`,
        area: 'Efficiency',
      });
    }
  }

  const totalRevenue = analyses.reduce((s, a) => s + a.monthlyRevenue, 0);
  const unprofitable = analyses.filter((a) => a.health === 'unprofitable');
  if (unprofitable.length > 0 && totalRevenue > 0) {
    const unprofitableRevenue = unprofitable.reduce((s, a) => s + a.monthlyRevenue, 0);
    recs.push({
      segment: 'Portfolio',
      priority: 'critical',
      action: `${Math.round((unprofitableRevenue / totalRevenue) * 100)}% of revenue comes from unprofitable segments`,
      area: 'Portfolio Strategy',
    });
  }

  return recs;
}

export function processUnitEconomics(
  segments: CustomerSegment[]
): Omit<UnitEconomicsResult, 'source'> {
  const analyses = segments.map(analyzeSegment);
  const recommendations = generateRecommendations(analyses);

  const totalMRR = analyses.reduce((s, a) => s + a.monthlyRevenue, 0);
  const weightedLtvCac =
    totalMRR > 0
      ? analyses.reduce((s, a) => s + a.ltvCacRatio * a.monthlyRevenue, 0) / totalMRR
      : analyses.reduce((s, a) => s + a.ltvCacRatio, 0) / (analyses.length || 1);

  return {
    portfolio: {
      totalMRR,
      totalARR: totalMRR * 12,
      weightedLtvCacRatio: Math.round(weightedLtvCac * 100) / 100,
      segmentCount: analyses.length,
    },
    segments: analyses,
    recommendations,
  };
}
