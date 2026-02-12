#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const ENERGY_FACTORS = {
  dockerCompose: { kwhPerMonth: 50, label: 'Docker containers (estimated)' },
  kubernetes: { kwhPerMonth: 200, label: 'Kubernetes cluster (estimated)' },
  cicdPipeline: { kwhPerMonth: 30, label: 'CI/CD pipelines (estimated)' },
  database: { kwhPerMonth: 100, label: 'Database server (estimated)' },
};

function assessInfraEnergy(dir) {
  const usage = [];
  const exists = p => fs.existsSync(path.join(dir, p));
  if (exists('docker-compose.yml') || exists('Dockerfile')) usage.push(ENERGY_FACTORS.dockerCompose);
  if (exists('k8s') || exists('kubernetes') || exists('helm')) usage.push(ENERGY_FACTORS.kubernetes);
  if (exists('.github/workflows') || exists('.gitlab-ci.yml')) usage.push(ENERGY_FACTORS.cicdPipeline);
  // Check for database usage
  if (exists('package.json')) {
    try {
      const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies || {}).join(' ');
      if (/pg|mysql|mongo|redis|sequelize|prisma/i.test(deps)) usage.push(ENERGY_FACTORS.database);
    } catch(_e){}
  }
  const totalKwh = usage.reduce((s, u) => s + u.kwhPerMonth, 0);
  const co2Kg = Math.round(totalKwh * 0.4 * 10) / 10; // Global average CO2 per kWh
  return { components: usage, estimatedMonthlyKwh: totalKwh, estimatedMonthlyCO2Kg: co2Kg, annualCO2Kg: Math.round(co2Kg * 12) };
}

function findWaste(dir) {
  const waste = [];
  const allFiles = getAllFiles(dir, { maxDepth: 3 });
  for (const full of allFiles) {
    try {
      const stat = fs.statSync(full);
      if (stat.size > 10 * 1024 * 1024) waste.push({ file: path.relative(dir, full), size: stat.size, issue: 'Large file (>10MB) - consider compression or external storage' });
      if (/\.(log|tmp|bak|old|orig)$/.test(path.basename(full))) waste.push({ file: path.relative(dir, full), size: stat.size, issue: 'Temporary/log file in repository' });
    } catch (_e) {}
  }
  return waste;
}

function generateRecommendations(energy, waste) {
  const recs = [];
  if (energy.estimatedMonthlyKwh > 200) recs.push({ priority: 'high', action: 'Consider serverless or spot instances to reduce always-on compute', savings: '30-60% energy reduction' });
  if (energy.components.some(c => c.label.includes('Kubernetes'))) recs.push({ priority: 'medium', action: 'Enable cluster autoscaling and use preemptible nodes', savings: '20-40% compute reduction' });
  if (waste.length > 0) recs.push({ priority: 'medium', action: `Remove ${waste.length} wasteful files (${Math.round(waste.reduce((s, w) => s + w.size, 0) / 1024)} KB total)`, savings: 'Reduced storage footprint' });
  recs.push({ priority: 'low', action: 'Choose green cloud regions with renewable energy', savings: 'Up to 80% carbon reduction' });
  return recs;
}

runSkill('sustainability-consultant', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const energy = assessInfraEnergy(targetDir);
  const waste = findWaste(targetDir);
  const recommendations = generateRecommendations(energy, waste);
  const result = {
    directory: targetDir, carbonFootprint: energy, waste: waste.slice(0, 20), wasteCount: waste.length,
    greenScore: Math.max(0, 100 - energy.estimatedMonthlyKwh / 5 - waste.length * 2),
    recommendations,
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
