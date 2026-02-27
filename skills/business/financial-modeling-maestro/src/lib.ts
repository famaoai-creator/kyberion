import { FinancialMetrics } from '@agent/core/shared-business-types';

export interface CostAssumptions {
  initial_monthly_cost?: number;
  cost_growth_rate?: number;
  headcount?: number;
  avg_salary?: number;
}

/**
 * Extends common FinancialMetrics with specific assumptions for modeling.
 */
export interface FinancialAssumptions extends FinancialMetrics {
  costs?: CostAssumptions;
  // FinancialMetrics provides: mrr, growthRate, churnRate, cashOnHand
}

export interface MonthlyProjection {
  month: number;
  mrr: number;
  expenses: number;
  netIncome: number;
  cashBalance: number;
}

export interface YearlyProjection {
  year: number;
  annualRevenue: number;
  annualCosts: number;
  annualProfit: number;
  endCash: number;
}

export interface RunwayAnalysis {
  runwayMonths: number;
  breakevenMonth: number | null;
  sustainable?: boolean;
}

export interface PnLResult {
  monthly: MonthlyProjection[];
  yearly: YearlyProjection[];
}

export function generatePnL(assumptions: FinancialAssumptions, years: number): PnLResult {
  const months = Math.max(1, Math.min(120, years * 12)); // Cap at 10 years
  const costs = assumptions.costs || {};

  let mrr = Math.max(0, assumptions.mrr || 10000);
  const growthRate = Math.max(-1, Math.min(5, assumptions.growthRate || 0.05));
  const churnRate = Math.max(0, Math.min(1, assumptions.churnRate || 0.03));

  let monthlyCost = Math.max(0, costs.initial_monthly_cost || 5000);
  const costGrowthRate = Math.max(-1, Math.min(5, costs.cost_growth_rate || 0.03));
  const headcount = Math.max(0, costs.headcount || 0);
  const avgSalary = Math.max(0, costs.avg_salary || 0);
  const monthlySalaries = Math.round((headcount * avgSalary) / 12);

  let cashOnHand = assumptions.cashOnHand || 0;

  const monthly: MonthlyProjection[] = [];
  const yearly: YearlyProjection[] = [];
  let yearRevenue = 0;
  let yearCosts = 0;

  for (let m = 1; m <= months; m++) {
    const netGrowth = growthRate - churnRate;
    mrr = mrr * (1 + netGrowth);
    monthlyCost = monthlyCost * (1 + costGrowthRate / 12);

    const totalMonthlyExpense = monthlyCost + monthlySalaries;
    const netIncome = mrr - totalMonthlyExpense;
    cashOnHand += netIncome;

    yearRevenue += mrr;
    yearCosts += totalMonthlyExpense;

    monthly.push({
      month: m,
      mrr: Math.round(mrr),
      expenses: Math.round(totalMonthlyExpense),
      netIncome: Math.round(netIncome),
      cashBalance: Math.round(cashOnHand),
    });

    if (m % 12 === 0) {
      yearly.push({
        year: m / 12,
        annualRevenue: Math.round(yearRevenue),
        annualCosts: Math.round(yearCosts),
        annualProfit: Math.round(yearRevenue - yearCosts),
        endCash: Math.round(cashOnHand),
      });
      yearRevenue = 0;
      yearCosts = 0;
    }
  }

  return { monthly, yearly };
}

export function analyzeRunway(monthly: MonthlyProjection[]): RunwayAnalysis {
  for (let i = 0; i < monthly.length; i++) {
    if (monthly[i].cashBalance <= 0) {
      return { runwayMonths: i + 1, breakevenMonth: null, sustainable: false };
    }
  }
  const breakevenMonthIndex = monthly.findIndex((m) => m.netIncome > 0);
  return {
    runwayMonths: monthly.length,
    breakevenMonth: breakevenMonthIndex >= 0 ? breakevenMonthIndex + 1 : null,
    sustainable: true,
  };
}

export function generateScenarios(
  assumptions: FinancialAssumptions,
  years: number
): Record<string, PnLResult> {
  const base = generatePnL(assumptions, years);

  // Optimistic
  const optimisticAssumptions: FinancialAssumptions = JSON.parse(JSON.stringify(assumptions));
  optimisticAssumptions.growthRate = (assumptions.growthRate || 0.05) * 1.5;
  const optimistic = generatePnL(optimisticAssumptions, years);

  // Pessimistic
  const pessimisticAssumptions: FinancialAssumptions = JSON.parse(JSON.stringify(assumptions));
  pessimisticAssumptions.growthRate = (assumptions.growthRate || 0.05) * 0.5;
  pessimisticAssumptions.churnRate = (assumptions.churnRate || 0.03) * 2;
  const pessimistic = generatePnL(pessimisticAssumptions, years);

  return { base, optimistic, pessimistic };
}
