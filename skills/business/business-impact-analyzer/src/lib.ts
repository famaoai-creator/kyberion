import { FinancialMetrics, StrategicAction } from '@agent/core/shared-business-types';

export interface DORAInput {
  deployment_frequency_per_week?: number;
  lead_time_hours?: number;
  change_failure_rate?: number;
  mttr_hours?: number;
}

export interface QualityInput {
  error_rate_per_1000?: number;
  test_coverage?: number;
  tech_debt_hours?: number;
}

/**
 * Business input for impact analysis, extending shared financial metrics.
 */
export interface BusinessInput extends FinancialMetrics {
  hourly_revenue?: number;
  developer_hourly_cost?: number;
  team_size?: number;
}

export interface AnalysisInput {
  dora?: DORAInput;
  quality?: QualityInput;
  business?: BusinessInput;
}

export type DORAValue = 'elite' | 'high' | 'medium' | 'low';

export interface DORAClassification {
  metrics: {
    deployment_frequency: DORAValue;
    lead_time: DORAValue;
    change_failure_rate: DORAValue;
    mttr: DORAValue;
  };
  overallLevel: DORAValue;
}

export interface BusinessImpact {
  monthlyDowntimeCost: number;
  monthlyErrorCost: number;
  techDebtMonthlyCost: number;
  totalMonthlyImpact: number;
  annualImpact: number;
  coverageRisk: 'low' | 'medium' | 'high' | 'critical';
}

export interface ROIRecommendation extends StrategicAction {
  estimatedSavings: number;
}

export interface AnalysisResult {
  source?: string;
  doraClassification: DORAClassification;
  businessImpact: BusinessImpact;
  recommendations: ROIRecommendation[];
}

export function classifyDORA(dora: DORAInput): DORAClassification {
  const scores: DORAClassification['metrics'] = {
    deployment_frequency: 'low',
    lead_time: 'low',
    change_failure_rate: 'low',
    mttr: 'low',
  };

  const freq = dora.deployment_frequency_per_week || 0;
  if (freq >= 7) scores.deployment_frequency = 'elite';
  else if (freq >= 3) scores.deployment_frequency = 'high';
  else if (freq >= 1) scores.deployment_frequency = 'medium';

  const lt = dora.lead_time_hours || 999;
  if (lt <= 1) scores.lead_time = 'elite';
  else if (lt <= 24) scores.lead_time = 'high';
  else if (lt <= 168) scores.lead_time = 'medium';

  const cfr = dora.change_failure_rate || 1;
  if (cfr <= 0.05) scores.change_failure_rate = 'elite';
  else if (cfr <= 0.1) scores.change_failure_rate = 'high';
  else if (cfr <= 0.15) scores.change_failure_rate = 'medium';

  const mttr = dora.mttr_hours || 999;
  if (mttr <= 1) scores.mttr = 'elite';
  else if (mttr <= 4) scores.mttr = 'high';
  else if (mttr <= 24) scores.mttr = 'medium';

  const levels = Object.values(scores);
  const levelOrder: DORAValue[] = ['elite', 'high', 'medium', 'low'];
  const overallLevel = levels.reduce(
    (w, l) => (levelOrder.indexOf(l) > levelOrder.indexOf(w) ? l : w),
    'elite' as DORAValue
  );

  return { metrics: scores, overallLevel };
}

export function calculateBusinessImpact(
  dora: DORAInput,
  quality: QualityInput,
  business: BusinessInput
): BusinessImpact {
  const hourlyRevenue = business.hourly_revenue || 0;
  const devCost = business.developer_hourly_cost || 80;

  const cfr = dora.change_failure_rate || 0;
  const deployFreq = dora.deployment_frequency_per_week || 0;
  const mttr = dora.mttr_hours || 0;
  const weeklyFailures = deployFreq * cfr;
  const weeklyDowntimeHours = weeklyFailures * mttr;
  const monthlyDowntimeCost = weeklyDowntimeHours * hourlyRevenue * 4.33;

  const errorRate = quality.error_rate_per_1000 || 0;
  const monthlyErrorCost = (errorRate / 1000) * hourlyRevenue * 730;

  const techDebtHours = quality.tech_debt_hours || 0;
  const techDebtMonthlyCost = techDebtHours * devCost;

  const coverage = quality.test_coverage || 0;
  let coverageRisk: BusinessImpact['coverageRisk'] = 'low';
  if (coverage < 0.6) coverageRisk = 'critical';
  else if (coverage < 0.8) coverageRisk = 'high';

  return {
    monthlyDowntimeCost: Math.round(monthlyDowntimeCost),
    monthlyErrorCost: Math.round(monthlyErrorCost),
    techDebtMonthlyCost: Math.round(techDebtMonthlyCost),
    totalMonthlyImpact: Math.round(monthlyDowntimeCost + monthlyErrorCost + techDebtMonthlyCost),
    annualImpact: Math.round((monthlyDowntimeCost + monthlyErrorCost + techDebtMonthlyCost) * 12),
    coverageRisk,
  };
}

export function generateROIRecommendations(
  doraClassification: DORAClassification,
  impact: BusinessImpact,
  quality: QualityInput
): ROIRecommendation[] {
  const recs: ROIRecommendation[] = [];

  if (doraClassification.overallLevel === 'low' || doraClassification.overallLevel === 'medium') {
    recs.push({
      action: 'Improve CI/CD pipeline to increase deployment frequency',
      estimatedSavings: Math.round(impact.monthlyDowntimeCost * 0.5),
      priority: 'high',
      area: 'DevOps',
    });
  }

  if (impact.techDebtMonthlyCost > 5000) {
    recs.push({
      action: `Allocate sprint capacity to reduce ${quality.tech_debt_hours}h tech debt backlog`,
      estimatedSavings: Math.round(impact.techDebtMonthlyCost * 0.3),
      priority: 'high',
      area: 'Technical Debt',
    });
  }

  if (impact.coverageRisk !== 'low') {
    recs.push({
      action: `Increase test coverage from ${Math.round((quality.test_coverage || 0) * 100)}% to 80%+`,
      estimatedSavings: Math.round(impact.monthlyErrorCost * 0.4),
      priority: impact.coverageRisk === 'critical' ? 'critical' : 'medium',
      area: 'Quality',
    });
  }

  if (doraClassification.metrics.mttr === 'medium' || doraClassification.metrics.mttr === 'low') {
    recs.push({
      action: 'Implement better observability (structured logging, alerting) to reduce MTTR',
      estimatedSavings: Math.round(impact.monthlyDowntimeCost * 0.3),
      priority: 'medium',
      area: 'Observability',
    });
  }

  return recs;
}

export function processImpactAnalysis(input: AnalysisInput): AnalysisResult {
  const dora = input.dora || {};
  const quality = input.quality || {};
  const business = input.business || {};

  const doraClassification = classifyDORA(dora);
  const impact = calculateBusinessImpact(dora, quality, business);
  const recommendations = generateROIRecommendations(doraClassification, impact, quality);

  // Add data integrity warnings to recommendations
  if (!input.dora)
    recommendations.push({
      action: 'Collect DORA metrics for more accurate downtime impact analysis',
      estimatedSavings: 0,
      priority: 'medium',
      area: 'Data Quality',
    });
  if (!input.quality)
    recommendations.push({
      action: 'Integrate quality/debt metrics to quantify maintenance overhead',
      estimatedSavings: 0,
      priority: 'medium',
      area: 'Data Quality',
    });
  if (!business.hourly_revenue)
    recommendations.push({
      action: 'Define hourly revenue to calculate financial ROI',
      estimatedSavings: 0,
      priority: 'high',
      area: 'Data Quality',
    });

  return {
    doraClassification,
    businessImpact: impact,
    recommendations,
  };
}
