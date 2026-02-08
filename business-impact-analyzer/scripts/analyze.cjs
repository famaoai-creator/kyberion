#!/usr/bin/env node
/**
 * business-impact-analyzer: Translates engineering metrics into business KPIs.
 * Analyzes DORA metrics, error rates, and technical debt to quantify business impact.
 */

const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON file with engineering metrics',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

/**
 * Expected input JSON format:
 * {
 *   "dora": {
 *     "deployment_frequency_per_week": 5,
 *     "lead_time_hours": 24,
 *     "change_failure_rate": 0.10,
 *     "mttr_hours": 2
 *   },
 *   "quality": {
 *     "error_rate_per_1000": 5,
 *     "test_coverage": 0.75,
 *     "tech_debt_hours": 200
 *   },
 *   "business": {
 *     "hourly_revenue": 1000,
 *     "developer_hourly_cost": 80,
 *     "team_size": 10
 *   }
 * }
 */

// DORA benchmarks (per Google's Accelerate research)
const _DORA_BENCHMARKS = {
  elite: { deployment_freq: 7, lead_time: 1, failure_rate: 0.05, mttr: 1 },
  high: { deployment_freq: 3, lead_time: 24, failure_rate: 0.10, mttr: 4 },
  medium: { deployment_freq: 1, lead_time: 168, failure_rate: 0.15, mttr: 24 },
  low: { deployment_freq: 0.15, lead_time: 720, failure_rate: 0.45, mttr: 168 },
};

function classifyDORA(dora) {
  const scores = {
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
  else if (cfr <= 0.10) scores.change_failure_rate = 'high';
  else if (cfr <= 0.15) scores.change_failure_rate = 'medium';

  const mttr = dora.mttr_hours || 999;
  if (mttr <= 1) scores.mttr = 'elite';
  else if (mttr <= 4) scores.mttr = 'high';
  else if (mttr <= 24) scores.mttr = 'medium';

  const levels = Object.values(scores);
  const levelOrder = ['elite', 'high', 'medium', 'low'];
  const worst = levels.reduce((w, l) => levelOrder.indexOf(l) > levelOrder.indexOf(w) ? l : w, 'elite');

  return { metrics: scores, overallLevel: worst };
}

function calculateBusinessImpact(dora, quality, business) {
  const hourlyRevenue = business.hourly_revenue || 0;
  const devCost = business.developer_hourly_cost || 80;
  const _teamSize = business.team_size || 1;

  // Downtime cost
  const cfr = dora.change_failure_rate || 0;
  const deployFreq = dora.deployment_frequency_per_week || 0;
  const mttr = dora.mttr_hours || 0;
  const weeklyFailures = deployFreq * cfr;
  const weeklyDowntimeHours = weeklyFailures * mttr;
  const monthlyDowntimeCost = weeklyDowntimeHours * hourlyRevenue * 4.33;

  // Error cost (user-facing errors lead to churn/support)
  const errorRate = quality.error_rate_per_1000 || 0;
  const monthlyErrorCost = (errorRate / 1000) * hourlyRevenue * 730; // ~730 hours per month

  // Tech debt cost (opportunity cost of developer time)
  const techDebtHours = quality.tech_debt_hours || 0;
  const techDebtMonthlyCost = techDebtHours * devCost;

  // Coverage risk
  const coverage = quality.test_coverage || 0;
  const coverageRisk = coverage < 0.8 ? 'high' : coverage < 0.6 ? 'critical' : 'low';

  return {
    monthlyDowntimeCost: Math.round(monthlyDowntimeCost),
    monthlyErrorCost: Math.round(monthlyErrorCost),
    techDebtMonthlyCost: Math.round(techDebtMonthlyCost),
    totalMonthlyImpact: Math.round(monthlyDowntimeCost + monthlyErrorCost + techDebtMonthlyCost),
    annualImpact: Math.round((monthlyDowntimeCost + monthlyErrorCost + techDebtMonthlyCost) * 12),
    coverageRisk,
  };
}

function generateROIRecommendations(doraClassification, impact, quality) {
  const recs = [];

  if (doraClassification.overallLevel === 'low' || doraClassification.overallLevel === 'medium') {
    recs.push({
      action: 'Improve CI/CD pipeline to increase deployment frequency',
      estimatedSavings: Math.round(impact.monthlyDowntimeCost * 0.5),
      priority: 'high',
    });
  }

  if (impact.techDebtMonthlyCost > 5000) {
    recs.push({
      action: `Allocate sprint capacity to reduce ${quality.tech_debt_hours}h tech debt backlog`,
      estimatedSavings: Math.round(impact.techDebtMonthlyCost * 0.3),
      priority: 'high',
    });
  }

  if (impact.coverageRisk !== 'low') {
    recs.push({
      action: `Increase test coverage from ${Math.round((quality.test_coverage || 0) * 100)}% to 80%+`,
      estimatedSavings: Math.round(impact.monthlyErrorCost * 0.4),
      priority: impact.coverageRisk === 'critical' ? 'critical' : 'medium',
    });
  }

  if (doraClassification.metrics.mttr === 'medium' || doraClassification.metrics.mttr === 'low') {
    recs.push({
      action: 'Implement better observability (structured logging, alerting) to reduce MTTR',
      estimatedSavings: Math.round(impact.monthlyDowntimeCost * 0.3),
      priority: 'medium',
    });
  }

  return recs;
}

runSkill('business-impact-analyzer', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const dora = data.dora || {};
  const quality = data.quality || {};
  const business = data.business || {};

  const doraClassification = classifyDORA(dora);
  const impact = calculateBusinessImpact(dora, quality, business);
  const recommendations = generateROIRecommendations(doraClassification, impact, quality);

  const result = {
    source: path.basename(resolved),
    doraClassification,
    businessImpact: impact,
    recommendations,
  };

  if (argv.out) {
    fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
