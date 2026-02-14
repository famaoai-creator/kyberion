#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('input', {
    alias: 'i',
    type: 'string',
    demandOption: true,
    description: 'Path to JSON with IP portfolio data',
  })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function analyzeIPAssets(data) {
  const assets = data.assets || [];
  return assets.map((asset) => {
    const developmentCost = asset.development_cost || 0;
    const annualMaintenance = asset.annual_maintenance || 0;
    const potentialRevenue = asset.potential_annual_revenue || 0;
    const roi =
      developmentCost > 0
        ? Math.round(((potentialRevenue - annualMaintenance) / developmentCost) * 100)
        : 0;
    return {
      name: asset.name,
      type: asset.type || 'software',
      status: asset.status || 'internal',
      developmentCost,
      annualMaintenance,
      potentialRevenue,
      roi,
      profitability: roi > 100 ? 'high' : roi > 50 ? 'medium' : roi > 0 ? 'low' : 'negative',
    };
  });
}

function designLicensingModels(assets) {
  const models = [];
  for (const asset of assets) {
    if (asset.profitability === 'high' || asset.profitability === 'medium') {
      models.push({
        asset: asset.name,
        models: [
          {
            type: 'SaaS License',
            description: 'Monthly/annual subscription access',
            estimatedRevenue: Math.round(asset.potentialRevenue * 0.7),
          },
          {
            type: 'Enterprise License',
            description: 'Unlimited use for large organizations',
            estimatedRevenue: Math.round(asset.potentialRevenue * 1.2),
          },
          {
            type: 'Open Core',
            description: 'Free base + paid premium features',
            estimatedRevenue: Math.round(asset.potentialRevenue * 0.4),
          },
        ],
      });
    }
  }
  return models;
}

runSkill('ip-profitability-architect', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const assets = analyzeIPAssets(data);
  const licensing = designLicensingModels(assets);
  const totalCost = assets.reduce((s, a) => s + a.developmentCost + a.annualMaintenance, 0);
  const totalPotential = assets.reduce((s, a) => s + a.potentialRevenue, 0);
  const result = {
    source: path.basename(resolved),
    assetCount: assets.length,
    assets,
    licensing,
    portfolio: {
      totalInvestment: totalCost,
      totalPotentialRevenue: totalPotential,
      portfolioROI:
        totalCost > 0 ? Math.round(((totalPotential - totalCost) / totalCost) * 100) : 0,
    },
    recommendations: assets
      .filter((a) => a.profitability === 'high')
      .map((a) => `[high] ${a.name}: ROI ${a.roi}% - prioritize commercialization`),
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
