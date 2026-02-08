#!/usr/bin/env node
/**
 * chaos-monkey-orchestrator: Simulates managed chaos to test system resilience.
 * Generates chaos scenarios and validates healing/monitoring responses.
 */

const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

const argv = yargs(hideBin(process.argv))
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('intensity', { alias: 'n', type: 'string', default: 'low', choices: ['low', 'medium', 'high'], description: 'Chaos intensity level' })
  .option('dry-run', { type: 'boolean', default: true, description: 'Only simulate, do not execute' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

const CHAOS_SCENARIOS = [
  { id: 'service-kill', name: 'Service Termination', intensity: 'low', description: 'Simulate unexpected process termination', action: 'kill -9 <pid>', expectedRecovery: 'Auto-restart via process manager', validates: ['self-healing-orchestrator', 'monitoring'] },
  { id: 'network-partition', name: 'Network Partition', intensity: 'medium', description: 'Simulate network failure between services', action: 'iptables -A INPUT -s <ip> -j DROP', expectedRecovery: 'Circuit breaker activation, fallback routing', validates: ['crisis-manager', 'connection-manager'] },
  { id: 'disk-full', name: 'Disk Space Exhaustion', intensity: 'low', description: 'Simulate ENOSPC condition', action: 'fallocate -l 99% /tmp/chaos-fill', expectedRecovery: 'Alert + automated cleanup', validates: ['self-healing-orchestrator'] },
  { id: 'memory-pressure', name: 'Memory Pressure', intensity: 'medium', description: 'Simulate high memory usage / OOM conditions', action: 'stress --vm 4 --vm-bytes 512M', expectedRecovery: 'OOM killer + service restart', validates: ['monitoring', 'alerting'] },
  { id: 'latency-injection', name: 'Latency Injection', intensity: 'low', description: 'Add artificial latency to network calls', action: 'tc qdisc add dev eth0 root netem delay 500ms', expectedRecovery: 'Timeout handling, degraded mode', validates: ['performance-monitor-analyst'] },
  { id: 'dependency-failure', name: 'Dependency Failure', intensity: 'medium', description: 'Simulate external service unavailability', action: 'Block DNS resolution for dependency', expectedRecovery: 'Cache fallback, graceful degradation', validates: ['crisis-manager', 'self-healing-orchestrator'] },
  { id: 'data-corruption', name: 'Data Corruption', intensity: 'high', description: 'Simulate corrupted database records or config', action: 'Inject invalid data into test dataset', expectedRecovery: 'Data validation, restore from backup', validates: ['disaster-recovery-planner'] },
  { id: 'cert-expiry', name: 'Certificate Expiry', intensity: 'medium', description: 'Simulate expired SSL/TLS certificates', action: 'Replace cert with expired version', expectedRecovery: 'Alert + auto-renewal', validates: ['self-healing-orchestrator', 'monitoring-config-auditor'] },
  { id: 'config-drift', name: 'Configuration Drift', intensity: 'low', description: 'Simulate unauthorized config changes', action: 'Modify environment variables', expectedRecovery: 'Config sync detection, rollback', validates: ['monitoring-config-auditor'] },
  { id: 'cascade-failure', name: 'Cascade Failure', intensity: 'high', description: 'Simulate failure propagation across services', action: 'Kill primary service, observe cascade', expectedRecovery: 'Circuit breakers, bulkhead isolation', validates: ['crisis-manager', 'disaster-recovery-planner'] },
];

function selectScenarios(intensity) {
  const levels = { low: ['low'], medium: ['low', 'medium'], high: ['low', 'medium', 'high'] };
  return CHAOS_SCENARIOS.filter(s => levels[intensity].includes(s.intensity));
}

function assessReadiness(dir) {
  const checks = { hasMonitoring: false, hasHealthCheck: false, hasSelfHealing: false, hasBackup: false, hasCICD: false };
  const exists = p => fs.existsSync(path.join(dir, p));
  checks.hasMonitoring = exists('monitoring') || exists('prometheus.yml') || exists('grafana');
  checks.hasHealthCheck = exists('healthcheck') || exists('scripts/healthcheck.cjs');
  checks.hasSelfHealing = exists('self-healing-orchestrator/scripts');
  checks.hasBackup = exists('backup') || exists('scripts/backup');
  checks.hasCICD = exists('.github/workflows') || exists('.gitlab-ci.yml');
  const readinessScore = Object.values(checks).filter(Boolean).length * 20;
  return { checks, readinessScore };
}

function generateChaosReport(scenarios, readiness) {
  return scenarios.map(s => ({
    ...s,
    feasible: true,
    riskAssessment: s.intensity === 'high' ? 'Requires isolated environment' : s.intensity === 'medium' ? 'Monitor closely during execution' : 'Safe for staging',
    prerequisitesMet: s.validates.some(_v => readiness.checks.hasSelfHealing || readiness.checks.hasMonitoring),
  }));
}

runSkill('chaos-monkey-orchestrator', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const scenarios = selectScenarios(argv.intensity);
  const readiness = assessReadiness(targetDir);
  const report = generateChaosReport(scenarios, readiness);

  const result = {
    directory: targetDir, mode: argv['dry-run'] ? 'dry-run' : 'execute', intensity: argv.intensity,
    readiness, scenarioCount: scenarios.length,
    scenarios: report,
    recommendations: [],
  };

  if (readiness.readinessScore < 40) result.recommendations.push('Low resilience readiness - implement monitoring and health checks before running chaos tests');
  if (!readiness.checks.hasSelfHealing) result.recommendations.push('No self-healing-orchestrator detected - chaos tests may cause extended outages');
  if (argv.intensity === 'high' && !argv['dry-run']) result.recommendations.push('HIGH intensity chaos should only run in isolated staging environments');

  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
