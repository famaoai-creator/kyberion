#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('./lib/core.cjs');

const rootDir = path.resolve(__dirname, '..');
const resultsDir = path.join(rootDir, 'evidence/benchmarks');

if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

const SKIP_DIRS = new Set([
  'node_modules',
  'knowledge',
  'scripts',
  'schemas',
  'templates',
  'evidence',
  'coverage',
  'test-results',
  'work',
  'nonfunctional',
  'dist',
  'tests',
  '.github',
]);

const skills = [];
const dirs = fs.readdirSync(rootDir).filter((f) => {
  const fullPath = path.join(rootDir, f);
  return fs.statSync(fullPath).isDirectory() && !f.startsWith('.') && !SKIP_DIRS.has(f);
});

for (const dir of dirs) {
  const scriptsDir = path.join(rootDir, dir, 'scripts');
  if (!fs.existsSync(scriptsDir)) continue;
  const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.cjs') || f.endsWith('.js'));
  if (files.length > 0) {
    skills.push({ name: dir, script: path.join(scriptsDir, files[0]) });
  }
}

console.log(`\nBenchmarking ${skills.length} implemented skills...\n`);

const results = [];

for (const skill of skills) {
  const iterations = 3;
  const times = [];

  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    try {
      execSync(`node --check "${skill.script}"`, { timeout: 5000, stdio: 'pipe' });
    } catch (_e) {
      // syntax check only
    }
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1e6); // ms
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  results.push({
    skill: skill.name,
    avg_ms: Math.round(avg * 100) / 100,
    min_ms: Math.round(min * 100) / 100,
    max_ms: Math.round(max * 100) / 100,
    iterations,
  });

  console.log(
    `  ${skill.name.padEnd(35)} avg: ${avg.toFixed(1)}ms  min: ${min.toFixed(1)}ms  max: ${max.toFixed(1)}ms`
  );
}

const report = {
  timestamp: new Date().toISOString(),
  node_version: process.version,
  total_skills: results.length,
  results,
};

const reportPath = path.join(resultsDir, `benchmark-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`\nBenchmark saved to: ${reportPath}`);
logger.success(`Benchmarked ${results.length} skills`);
