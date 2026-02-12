#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true, description: 'Path to JSON with feature/service data to sunset' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function planDeprecation(feature) {
  const timeline = [
    { phase: 'Announce', week: 1, action: `Announce deprecation of "${feature.name}" via changelog and in-app notice`, status: 'pending' },
    { phase: 'Soft Deprecation', week: 2, action: 'Add deprecation warnings in logs and API responses', status: 'pending' },
    { phase: 'Migration Support', week: 4, action: 'Provide migration guide and alternative recommendations', status: 'pending' },
    { phase: 'Hard Deprecation', week: 8, action: 'Return errors for deprecated endpoints, disable UI features', status: 'pending' },
    { phase: 'Data Archive', week: 10, action: 'Archive related data, export user data if applicable', status: 'pending' },
    { phase: 'Removal', week: 12, action: 'Remove code, clean up database, update documentation', status: 'pending' },
  ];
  return timeline;
}

function assessImpact(feature) {
  const users = feature.active_users || 0;
  const revenue = feature.monthly_revenue || 0;
  const dependencies = feature.dependencies || [];
  let risk = 'low';
  if (users > 1000 || revenue > 5000) risk = 'high';
  else if (users > 100 || revenue > 500) risk = 'medium';
  return { activeUsers: users, monthlyRevenue: revenue, dependencyCount: dependencies.length, dependencies, risk, migrationComplexity: dependencies.length > 3 ? 'high' : dependencies.length > 0 ? 'medium' : 'low' };
}

runSkill('sunset-architect', () => {
  const resolved = path.resolve(argv.input);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const features = data.features || [data];
  const plans = features.map(f => ({ feature: f.name || 'unknown', reason: f.reason || 'End of life', impact: assessImpact(f), deprecationTimeline: planDeprecation(f) }));
  const highRisk = plans.filter(p => p.impact.risk === 'high');
  const result = {
    source: path.basename(resolved), featureCount: plans.length, plans,
    totalAffectedUsers: plans.reduce((s, p) => s + p.impact.activeUsers, 0),
    totalRevenueImpact: plans.reduce((s, p) => s + p.impact.monthlyRevenue, 0),
    recommendations: [
      ...highRisk.map(p => `[high] "${p.feature}" has ${p.impact.activeUsers} active users - needs careful migration plan`),
      plans.length > 0 ? `Total deprecation timeline: ~12 weeks per feature` : 'No features to sunset',
    ],
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
