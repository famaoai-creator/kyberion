#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * budget-variance-tracker: Compares actual spend/revenue against forecasts.
 * Provides variance analysis and corrective insights.
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
    description: 'Path to JSON with actual vs forecast data',
  })
  .option('threshold', {
    alias: 't',
    type: 'number',
    default: 10,
    description: 'Variance threshold percentage to flag',
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
 *   "period": "2025-Q1",
 *   "categories": [
 *     { "name": "AWS Infrastructure", "forecast": 15000, "actual": 18500 },
 *     { "name": "SaaS Revenue", "forecast": 50000, "actual": 47000 },
 *     { "name": "Salaries", "forecast": 120000, "actual": 120000 }
 *   ]
 * }
 */

function analyzeVariance(category, threshold) {
  const forecast = category.forecast || 0;
  const actual = category.actual || 0;
  const variance = actual - forecast;
  const variancePercent = forecast !== 0 ? Math.round((variance / forecast) * 10000) / 100 : 0;
  const isOverBudget = variance > 0 && category.name.toLowerCase().includes('cost') ||
                       variance > 0 && !category.name.toLowerCase().includes('revenue');
  const isUnderRevenue = variance < 0 && category.name.toLowerCase().includes('revenue');

  let status = 'on_track';
  if (Math.abs(variancePercent) > threshold) {
    status = (isOverBudget || isUnderRevenue) ? 'negative_variance' : 'positive_variance';
  }

  return {
    name: category.name,
    forecast,
    actual,
    variance,
    variancePercent,
    status,
    flagged: Math.abs(variancePercent) > threshold,
  };
}

function generateInsights(analyses) {
  const insights = [];
  const flagged = analyses.filter(a => a.flagged);

  for (const item of flagged) {
    if (item.status === 'negative_variance') {
      insights.push({
        category: item.name,
        severity: Math.abs(item.variancePercent) > 25 ? 'critical' : 'warning',
        insight: `${item.name} is ${Math.abs(item.variancePercent)}% ${item.variance > 0 ? 'over budget' : 'under target'} ($${Math.abs(item.variance).toLocaleString()} ${item.variance > 0 ? 'overspend' : 'shortfall'})`,
        recommendation: item.variance > 0
          ? `Review ${item.name} spending. Consider cost optimization or renegotiation.`
          : `Investigate ${item.name} revenue shortfall. Check pipeline and conversion rates.`,
      });
    } else if (item.status === 'positive_variance') {
      insights.push({
        category: item.name,
        severity: 'info',
        insight: `${item.name} is ${Math.abs(item.variancePercent)}% ${item.variance < 0 ? 'under budget' : 'over target'} ($${Math.abs(item.variance).toLocaleString()} ${item.variance < 0 ? 'savings' : 'surplus'})`,
        recommendation: 'Consider reallocating surplus to underfunded areas.',
      });
    }
  }

  return insights;
}

runSkill('budget-variance-tracker', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!data.categories || !Array.isArray(data.categories)) throw new Error('Input must have a "categories" array');

  const analyses = data.categories.map(c => analyzeVariance(c, argv.threshold));
  const insights = generateInsights(analyses);

  const totalForecast = analyses.reduce((s, a) => s + a.forecast, 0);
  const totalActual = analyses.reduce((s, a) => s + a.actual, 0);
  const totalVariance = totalActual - totalForecast;

  const result = {
    period: data.period || 'unspecified',
    threshold: argv.threshold,
    summary: {
      totalForecast,
      totalActual,
      totalVariance,
      totalVariancePercent: totalForecast !== 0 ? Math.round((totalVariance / totalForecast) * 10000) / 100 : 0,
      categoriesAnalyzed: analyses.length,
      categoriesFlagged: analyses.filter(a => a.flagged).length,
    },
    categories: analyses,
    insights,
    overallHealth: insights.filter(i => i.severity === 'critical').length > 0 ? 'at_risk' : insights.filter(i => i.severity === 'warning').length > 0 ? 'needs_attention' : 'healthy',
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
