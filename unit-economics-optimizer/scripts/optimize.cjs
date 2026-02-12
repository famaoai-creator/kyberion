#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * unit-economics-optimizer: Analyzes LTV, CAC, and churn to evaluate product profitability.
 * Proposes pricing and retention strategies based on unit economics data.
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
    description: 'Path to JSON file with unit economics data',
  })
  .option('out', {
    alias: 'o',
    type: 'string',
    description: 'Output file path',
  })
  .help()
  .argv;

/**
 * Expected input JSON:
 * {
 *   "segments": [
 *     {
 *       "name": "Basic",
 *       "monthly_price": 29,
 *       "cac": 150,
 *       "monthly_churn_rate": 0.05,
 *       "gross_margin": 0.80,
 *       "customer_count": 500
 *     },
 *     {
 *       "name": "Enterprise",
 *       "monthly_price": 299,
 *       "cac": 2000,
 *       "monthly_churn_rate": 0.02,
 *       "gross_margin": 0.85,
 *       "customer_count": 50
 *     }
 *   ]
 * }
 */

function calculateLTV(segment) {
  const churn = segment.monthly_churn_rate || 0.05;
  const avgLifetimeMonths = churn > 0 ? 1 / churn : 120;
  const monthlyRevenue = segment.monthly_price || 0;
  const grossMargin = segment.gross_margin || 0.80;
  return Math.round(monthlyRevenue * grossMargin * avgLifetimeMonths);
}

function analyzeSegment(segment) {
  const ltv = calculateLTV(segment);
  const cac = segment.cac || 0;
  const ltvCacRatio = cac > 0 ? Math.round((ltv / cac) * 100) / 100 : Infinity;
  const churn = segment.monthly_churn_rate || 0.05;
  const avgLifetimeMonths = churn > 0 ? Math.round(1 / churn) : 120;
  const monthsToRecoverCAC = cac > 0 ? Math.ceil(cac / ((segment.monthly_price || 0) * (segment.gross_margin || 0.8))) : 0;

  let health = 'healthy';
  if (ltvCacRatio < 1) health = 'unprofitable';
  else if (ltvCacRatio < 3) health = 'at_risk';

  return {
    name: segment.name,
    monthlyPrice: segment.monthly_price,
    customerCount: segment.customer_count || 0,
    monthlyChurnRate: churn,
    avgLifetimeMonths,
    ltv,
    cac,
    ltvCacRatio,
    monthsToRecoverCAC,
    health,
    monthlyRevenue: Math.round((segment.monthly_price || 0) * (segment.customer_count || 0)),
  };
}

function generateRecommendations(analyses) {
  const recs = [];

  for (const seg of analyses) {
    if (seg.health === 'unprofitable') {
      recs.push({
        segment: seg.name,
        priority: 'critical',
        action: `LTV/CAC ratio is ${seg.ltvCacRatio} (<1). Consider raising prices, reducing CAC, or discontinuing segment.`,
      });
    }
    if (seg.health === 'at_risk') {
      recs.push({
        segment: seg.name,
        priority: 'high',
        action: `LTV/CAC ratio is ${seg.ltvCacRatio} (<3). Target ratio of 3+. Focus on reducing churn or lowering acquisition cost.`,
      });
    }
    if (seg.monthlyChurnRate > 0.05) {
      recs.push({
        segment: seg.name,
        priority: 'high',
        action: `Monthly churn ${Math.round(seg.monthlyChurnRate * 100)}% exceeds 5% threshold. Investigate with customer exit surveys and improve onboarding.`,
      });
    }
    if (seg.monthsToRecoverCAC > 12) {
      recs.push({
        segment: seg.name,
        priority: 'medium',
        action: `CAC payback period is ${seg.monthsToRecoverCAC} months. Target <12 months. Review marketing spend efficiency.`,
      });
    }
  }

  // Portfolio-level recommendations
  const totalRevenue = analyses.reduce((s, a) => s + a.monthlyRevenue, 0);
  const unprofitable = analyses.filter(a => a.health === 'unprofitable');
  if (unprofitable.length > 0) {
    const unprofitableRevenue = unprofitable.reduce((s, a) => s + a.monthlyRevenue, 0);
    recs.push({
      segment: 'Portfolio',
      priority: 'critical',
      action: `${Math.round((unprofitableRevenue / totalRevenue) * 100)}% of revenue comes from unprofitable segments`,
    });
  }

  return recs;
}

runSkill('unit-economics-optimizer', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!data.segments || !Array.isArray(data.segments) || data.segments.length === 0) {
    throw new Error('Input must contain a "segments" array with at least one customer segment');
  }

  const analyses = data.segments.map(analyzeSegment);
  const recommendations = generateRecommendations(analyses);

  const totalMRR = analyses.reduce((s, a) => s + a.monthlyRevenue, 0);
  const weightedLtvCac = analyses.reduce((s, a) => s + a.ltvCacRatio * a.monthlyRevenue, 0) / (totalMRR || 1);

  const result = {
    source: path.basename(resolved),
    portfolio: {
      totalMRR,
      totalARR: totalMRR * 12,
      weightedLtvCacRatio: Math.round(weightedLtvCac * 100) / 100,
      segmentCount: analyses.length,
    },
    segments: analyses,
    recommendations,
  };

  if (argv.out) {
    safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  }

  return result;
});
