import { ProjectIdentity, FinancialMetrics } from '@agent/core/shared-business-types';

export interface MarketFactors {
  tam_growth_rate?: number;
  competitive_pressure?: 'low' | 'medium' | 'high';
}

/**
 * Base assumptions extending shared project and financial metrics.
 */
export interface BaseAssumptions extends ProjectIdentity, FinancialMetrics {
  timeframe_months?: number;
  current_headcount?: number;
  // FinancialMetrics provides: mrr, monthlyBurn, cashOnHand
  market_factors?: MarketFactors;
}

export interface ScenarioTemplate {
  label: string;
  description: string;
  revenue_multiplier: number;
  cost_multiplier: number;
  headcount_growth: number;
  risk_level: 'low' | 'medium' | 'high' | 'very_high';
  key_bets: string[];
}

export interface TimelineEntry {
  month: number;
  mrr: number;
  burn: number;
  netIncome: number;
  cashBalance: number;
}

export interface ScenarioResult {
  scenario: string;
  description: string;
  riskLevel: string;
  keyBets: string[];
  projectedHeadcount: number;
  endState: FinancialMetrics & {
    profitable: boolean;
    runwayMonths: number | 'infinite';
  };
  timeline: TimelineEntry[];
}

export interface ComparisonResult {
  highestRevenue: string | null;
  longestRunway: string | null;
  lowestRisk: string | null;
  recommended: string | null;
}

export const SCENARIO_TEMPLATES: Record<string, ScenarioTemplate> = {
  aggressive_growth: {
    label: 'Aggressive Growth',
    description:
      'Maximize growth at the cost of higher burn. Hire aggressively, invest in marketing.',
    revenue_multiplier: 1.5,
    cost_multiplier: 1.8,
    headcount_growth: 0.5,
    risk_level: 'high',
    key_bets: ['Double marketing spend', 'Hire 3 engineers', 'Launch 2 new product lines'],
  },
  sustainable_growth: {
    label: 'Sustainable Growth',
    description: 'Balanced approach: grow revenue while maintaining reasonable burn rate.',
    revenue_multiplier: 1.2,
    cost_multiplier: 1.1,
    headcount_growth: 0.2,
    risk_level: 'medium',
    key_bets: ['Optimize conversion funnel', 'Hire 1 engineer', 'Expand to 1 new market'],
  },
  stability: {
    label: 'Stability / Cash Preservation',
    description: 'Minimize risk. Focus on profitability and extending runway.',
    revenue_multiplier: 1.05,
    cost_multiplier: 0.9,
    headcount_growth: 0,
    risk_level: 'low',
    key_bets: ['Reduce non-essential spend', 'Focus on retention', 'Build operational efficiency'],
  },
  pivot: {
    label: 'Strategic Pivot',
    description: 'Redirect resources toward a new market or product direction.',
    revenue_multiplier: 0.8,
    cost_multiplier: 1.3,
    headcount_growth: 0.1,
    risk_level: 'very_high',
    key_bets: ['R&D investment in new direction', 'Market research', 'MVP for new product'],
  },
  exit_prep: {
    label: 'Exit Preparation',
    description: 'Optimize metrics for acquisition or IPO readiness.',
    revenue_multiplier: 1.15,
    cost_multiplier: 0.95,
    headcount_growth: 0.1,
    risk_level: 'medium',
    key_bets: ['Clean up tech debt', 'Improve documentation', 'Optimize unit economics'],
  },
};

export function projectScenario(
  base: BaseAssumptions,
  template: ScenarioTemplate,
  months: number
): ScenarioResult {
  const mrr = base.mrr || 10000;
  const burn = base.monthlyBurn || 50000;
  const cash = base.cashOnHand || 100000;
  const headcount = base.current_headcount || 5;

  const monthlyRevGrowth = Math.pow(template.revenue_multiplier, 1 / 12) - 1;
  const monthlyCostGrowth = Math.pow(template.cost_multiplier, 1 / 12) - 1;

  let currentMRR = mrr;
  let currentBurn = burn;
  let currentCash = cash;
  const timeline: TimelineEntry[] = [];

  for (let m = 1; m <= months; m++) {
    currentMRR *= 1 + monthlyRevGrowth;
    currentBurn *= 1 + monthlyCostGrowth;
    const netIncome = currentMRR - currentBurn;
    currentCash += netIncome;

    if (m % 3 === 0 || m === months) {
      timeline.push({
        month: m,
        mrr: Math.round(currentMRR),
        burn: Math.round(currentBurn),
        netIncome: Math.round(netIncome),
        cashBalance: Math.round(currentCash),
      });
    }
  }

  const finalHeadcount = Math.round(headcount * (1 + template.headcount_growth));
  let runwayMonths: number | 'infinite' = 0;

  if (currentMRR >= currentBurn) {
    runwayMonths = 'infinite';
  } else if (currentCash > 0) {
    runwayMonths = Math.round(currentCash / (currentBurn - currentMRR));
  }

  return {
    scenario: template.label,
    description: template.description,
    riskLevel: template.risk_level,
    keyBets: template.key_bets,
    projectedHeadcount: finalHeadcount,
    endState: {
      mrr: Math.round(currentMRR),
      annualRevenue: Math.round(currentMRR * 12),
      monthlyBurn: Math.round(currentBurn),
      cashOnHand: Math.round(currentCash),
      profitable: currentMRR >= currentBurn,
      runwayMonths,
    },
    timeline,
  };
}

export function compareScenarios(scenarios: ScenarioResult[]): ComparisonResult {
  if (scenarios.length === 0) {
    return { highestRevenue: null, longestRunway: null, lowestRisk: null, recommended: null };
  }

  const comparison: ComparisonResult = {
    highestRevenue: null,
    longestRunway: null,
    lowestRisk: null,
    recommended: null,
  };

  let maxRev = -1;
  let maxRunway = -1;

  for (const s of scenarios) {
    if (s.endState.mrr! > maxRev) {
      maxRev = s.endState.mrr!;
      comparison.highestRevenue = s.scenario;
    }
    const runway = s.endState.runwayMonths === 'infinite' ? 9999 : s.endState.runwayMonths;
    if (runway > maxRunway) {
      maxRunway = runway;
      comparison.longestRunway = s.scenario;
    }
  }

  const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2, very_high: 3 };
  comparison.lowestRisk = scenarios.reduce((best, s) => {
    const currentRisk = riskOrder[s.riskLevel] ?? 3;
    const bestRisk = riskOrder[best.riskLevel] ?? 3;
    return currentRisk < bestRisk ? s : best;
  }, scenarios[0]).scenario;

  // Improved Recommendation Logic:
  // Prefer 'medium' risk if runway > 12 months, otherwise prefer 'low' risk (stability)
  const balanced = scenarios.find((s) => s.riskLevel === 'medium');
  const stability = scenarios.find((s) => s.riskLevel === 'low');

  if (
    balanced &&
    (balanced.endState.runwayMonths === 'infinite' || balanced.endState.runwayMonths > 12)
  ) {
    comparison.recommended = balanced.scenario;
  } else {
    comparison.recommended = stability ? stability.scenario : scenarios[0].scenario;
  }

  return comparison;
}
