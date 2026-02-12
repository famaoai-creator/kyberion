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

const MONITORING_CHECKS = [
  { id: 'health-endpoint', patterns: ['/health', '/healthz', '/ready', '/readiness', '/liveness'], type: 'code', label: 'Health check endpoint' },
  { id: 'metrics-endpoint', patterns: ['/metrics', 'prometheus', 'prom-client', 'express-prometheus'], type: 'code', label: 'Metrics endpoint' },
  { id: 'logging', patterns: ['winston', 'pino', 'bunyan', 'morgan', 'log4js', 'console.error', 'logger'], type: 'dependency', label: 'Structured logging' },
  { id: 'alerting', patterns: ['alertmanager', 'pagerduty', 'opsgenie', 'slack-webhook', 'alert'], type: 'config', label: 'Alerting configuration' },
  { id: 'apm', patterns: ['datadog', 'new-relic', 'sentry', 'elastic-apm', '@opentelemetry'], type: 'dependency', label: 'APM / Tracing' },
  { id: 'uptime', patterns: ['uptime', 'pingdom', 'statuspage', 'betteruptime'], type: 'config', label: 'Uptime monitoring' },
];

function auditMonitoring(dir) {
  const results = [];
  for (const check of MONITORING_CHECKS) {
    let found = false, evidence = null;
    // Check in package.json dependencies
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const allDeps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).join(' ');
        for (const p of check.patterns) { if (allDeps.includes(p)) { found = true; evidence = `dependency: ${p}`; break; } }
      } catch(_e){}
    }
    // Search in source code
    if (!found) {
      const allFiles = getAllFiles(dir, { maxDepth: 3 });
      for (const full of allFiles) {
        if (!['.js', '.cjs', '.ts', '.yml', '.yaml', '.json'].includes(path.extname(full))) continue;
        try {
          const content = fs.readFileSync(full, 'utf8').toLowerCase();
          for (const p of check.patterns) {
            if (content.includes(p.toLowerCase())) {
              found = true;
              evidence = path.relative(dir, full);
              break;
            }
          }
        } catch (_e) {}
        if (found) break;
      }
    }
    results.push({ id: check.id, label: check.label, status: found ? 'configured' : 'missing', evidence });
  }
  return results;
}

function calculateScore(results) {
  const configured = results.filter(r => r.status === 'configured').length;
  return Math.round((configured / results.length) * 100);
}

runSkill('monitoring-config-auditor', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const results = auditMonitoring(targetDir);
  const score = calculateScore(results);
  const missing = results.filter(r => r.status === 'missing');
  const result = {
    directory: targetDir, score, status: score >= 80 ? 'well_monitored' : score >= 50 ? 'partial' : 'insufficient',
    checks: results, missingCount: missing.length,
    recommendations: missing.map(m => `[missing] Set up ${m.label}`),
  };
  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
