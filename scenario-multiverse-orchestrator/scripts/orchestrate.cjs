#!/usr/bin/env node
/**
 * scenario-multiverse-orchestrator: Generates multiple business scenarios
 * (Growth/Stability/Hybrid) from financial and strategic assumptions.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON file with base assumptions',
  })
  .option('scenarios', {
    alias: 's',
    type: 'number',
    default: 3,
    description: 'Number of scenarios to generate',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

/**
 * Expected input:
 * {
 *   "company": "Acme Corp",
 *   "timeframe_months": 12,
 *   "current_mrr": 50000,
 *   "current_headcount": 10,
 *   "monthly_burn": 80000,
 *   "cash_on_hand": 500000,
 *   "market_factors": { "tam_growth_rate": 0.15, "competitive_pressure": "medium" }
 * }
 */

const SCENARIO_TEMPLATES = {
  aggressive_growth: {
    label: 'Aggressive Growth',
    description: 'Maximize growth at the cost of higher burn. Hire aggressively, invest in marketing.',
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

function projectScenario(base, template, months) {
  const mrr = base.current_mrr || 10000;
  const burn = base.monthly_burn || 50000;
  const cash = base.cash_on_hand || 100000;
  const headcount = base.current_headcount || 5;

  const monthlyRevGrowth = Math.pow(template.revenue_multiplier, 1 / 12) - 1;
  const monthlyCostGrowth = Math.pow(template.cost_multiplier, 1 / 12) - 1;

  let currentMRR = mrr;
  let currentBurn = burn;
  let currentCash = cash;
  const timeline = [];

  for (let m = 1; m <= months; m++) {
    currentMRR *= (1 + monthlyRevGrowth);
    currentBurn *= (1 + monthlyCostGrowth);
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
  const runwayMonths = currentCash > 0 && currentMRR < currentBurn
    ? Math.round(currentCash / (currentBurn - currentMRR))
    : currentMRR >= currentBurn ? Infinity : 0;

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
      cashBalance: Math.round(currentCash),
      profitable: currentMRR >= currentBurn,
      runwayMonths: runwayMonths === Infinity ? 'infinite' : runwayMonths,
    },
    timeline,
  };
}

function compareScenarios(scenarios) {
  const comparison = {
    highestRevenue: null,
    longestRunway: null,
    lowestRisk: null,
    recommended: null,
  };

  let maxRev = 0, maxRunway = 0;
  for (const s of scenarios) {
    if (s.endState.mrr > maxRev) { maxRev = s.endState.mrr; comparison.highestRevenue = s.scenario; }
    const runway = s.endState.runwayMonths === 'infinite' ? 9999 : s.endState.runwayMonths;
    if (runway > maxRunway) { maxRunway = runway; comparison.longestRunway = s.scenario; }
  }

  comparison.lowestRisk = scenarios.reduce((best, s) => {
    const riskOrder = { low: 0, medium: 1, high: 2, very_high: 3 };
    return (riskOrder[s.riskLevel] || 3) < (riskOrder[best.riskLevel] || 3) ? s : best;
  }, scenarios[0]).scenario;

  // Recommend balanced option
  comparison.recommended = scenarios.find(s => s.riskLevel === 'medium')?.scenario || scenarios[0].scenario;

  return comparison;
}

runSkill('scenario-multiverse-orchestrator', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

  const base = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const months = base.timeframe_months || 12;
  const numScenarios = Math.min(argv.scenarios, Object.keys(SCENARIO_TEMPLATES).length);

  const templateKeys = Object.keys(SCENARIO_TEMPLATES).slice(0, numScenarios);
  const scenarios = templateKeys.map(key => projectScenario(base, SCENARIO_TEMPLATES[key], months));
  const comparison = compareScenarios(scenarios);

  const result = {
    company: base.company || 'Unknown',
    timeframeMonths: months,
    baselineMetrics: {
      currentMRR: base.current_mrr,
      monthlyBurn: base.monthly_burn,
      cashOnHand: base.cash_on_hand,
      headcount: base.current_headcount,
    },
    scenarios,
    comparison,
  };

  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
