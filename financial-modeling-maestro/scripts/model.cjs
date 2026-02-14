#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
/**
 * financial-modeling-maestro: Generates financial models from JSON assumption files.
 * Produces P&L, cash flow projections, and scenario analysis.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON file with financial assumptions',
  })
  .option('years', {
    alias: 'y',
    type: 'number',
    default: 3,
    description: 'Number of years to project',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help().argv;

/**
 * Expected input JSON format:
 * {
 *   "revenue": { "initial_mrr": 10000, "monthly_growth_rate": 0.10, "churn_rate": 0.03 },
 *   "costs": { "initial_monthly_cost": 8000, "cost_growth_rate": 0.05, "headcount": 5, "avg_salary": 80000 },
 *   "funding": { "cash_on_hand": 500000, "monthly_burn_override": null }
 * }
 */

function generatePnL(assumptions, years) {
  const months = years * 12;
  const rev = assumptions.revenue || {};
  const costs = assumptions.costs || {};
  const funding = assumptions.funding || {};

  let mrr = rev.initial_mrr || 10000;
  const growthRate = rev.monthly_growth_rate || 0.05;
  const churnRate = rev.churn_rate || 0.03;

  let monthlyCost = costs.initial_monthly_cost || 5000;
  const costGrowthRate = costs.cost_growth_rate || 0.03;
  const headcount = costs.headcount || 0;
  const avgSalary = costs.avg_salary || 0;
  const monthlySalaries = (headcount * avgSalary) / 12;

  let cashOnHand = funding.cash_on_hand || 0;

  const monthly = [];
  const yearly = [];
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

function analyzeRunway(monthly, _initialCash) {
  for (let i = 0; i < monthly.length; i++) {
    if (monthly[i].cashBalance <= 0) {
      return { runwayMonths: i + 1, breakevenMonth: null };
    }
  }
  // Find breakeven (first month with positive net income)
  const breakevenMonth = monthly.findIndex((m) => m.netIncome > 0);
  return {
    runwayMonths: monthly.length,
    breakevenMonth: breakevenMonth >= 0 ? breakevenMonth + 1 : null,
    sustainable: true,
  };
}

function generateScenarios(assumptions, years) {
  const scenarios = {};

  // Base case
  scenarios.base = generatePnL(assumptions, years);

  // Optimistic: 50% higher growth
  const optimistic = JSON.parse(JSON.stringify(assumptions));
  if (optimistic.revenue)
    optimistic.revenue.monthly_growth_rate =
      (assumptions.revenue.monthly_growth_rate || 0.05) * 1.5;
  scenarios.optimistic = generatePnL(optimistic, years);

  // Pessimistic: half growth, double churn
  const pessimistic = JSON.parse(JSON.stringify(assumptions));
  if (pessimistic.revenue) {
    pessimistic.revenue.monthly_growth_rate =
      (assumptions.revenue.monthly_growth_rate || 0.05) * 0.5;
    pessimistic.revenue.churn_rate = (assumptions.revenue.churn_rate || 0.03) * 2;
  }
  scenarios.pessimistic = generatePnL(pessimistic, years);

  return scenarios;
}

runSkill('financial-modeling-maestro', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const assumptions = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const years = argv.years;

  const projections = generatePnL(assumptions, years);
  const runway = analyzeRunway(projections.monthly, (assumptions.funding || {}).cash_on_hand || 0);
  const scenarios = generateScenarios(assumptions, years);

  const result = {
    source: path.basename(resolved),
    projectionYears: years,
    yearlyProjections: projections.yearly,
    runway,
    scenarios: {
      base: { yearly: scenarios.base.yearly },
      optimistic: { yearly: scenarios.optimistic.yearly },
      pessimistic: { yearly: scenarios.pessimistic.yearly },
    },
    recommendations: [],
  };

  // Generate recommendations
  if (runway.breakevenMonth) {
    result.recommendations.push(`Breakeven expected at month ${runway.breakevenMonth}`);
  } else if (!runway.sustainable) {
    result.recommendations.push(
      `Cash runs out at month ${runway.runwayMonths} - consider reducing burn or raising funding`
    );
  }

  const lastYear = projections.yearly[projections.yearly.length - 1];
  if (lastYear && lastYear.annualProfit < 0) {
    result.recommendations.push(
      'Final year still unprofitable - review cost structure or growth strategy'
    );
  }

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
