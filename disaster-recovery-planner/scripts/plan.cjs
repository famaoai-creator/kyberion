#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * disaster-recovery-planner: Generates DR runbooks from infrastructure and requirements.
 * Validates IaC for resilience (backups, redundancy).
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('rto', { type: 'number', default: 4, description: 'Recovery Time Objective in hours' })
  .option('rpo', { type: 'number', default: 1, description: 'Recovery Point Objective in hours' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function detectInfrastructure(dir) {
  const infra = {
    services: [],
    databases: [],
    storage: [],
    messaging: [],
    containerized: false,
    orchestrated: false,
  };
  const exists = (p) => fs.existsSync(path.join(dir, p));

  if (exists('Dockerfile') || exists('docker-compose.yml')) infra.containerized = true;
  if (exists('k8s') || exists('kubernetes') || exists('helm')) infra.orchestrated = true;

  // Scan for service definitions
  if (exists('docker-compose.yml') || exists('docker-compose.yaml')) {
    try {
      const content = fs.readFileSync(
        path.join(dir, exists('docker-compose.yml') ? 'docker-compose.yml' : 'docker-compose.yaml'),
        'utf8'
      );
      if (/postgres|mysql|mariadb/i.test(content)) infra.databases.push('relational');
      if (/mongo/i.test(content)) infra.databases.push('mongodb');
      if (/redis/i.test(content)) infra.messaging.push('redis');
      if (/rabbitmq|kafka/i.test(content)) infra.messaging.push('message-queue');
      if (/nginx|traefik/i.test(content)) infra.services.push('reverse-proxy');
      if (/elasticsearch|opensearch/i.test(content)) infra.services.push('search');
      if (/minio|s3/i.test(content)) infra.storage.push('object-storage');
    } catch (_e) {}
  }

  // Scan package.json for clues
  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const allDeps = Object.keys({
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      }).join(' ');
      if (/pg|postgres|mysql2?|sequelize|prisma|typeorm/i.test(allDeps))
        infra.databases.push('relational');
      if (/mongoose|mongodb/i.test(allDeps)) infra.databases.push('mongodb');
      if (/redis|ioredis/i.test(allDeps)) infra.messaging.push('redis');
      if (/amqplib|kafkajs/i.test(allDeps)) infra.messaging.push('message-queue');
      if (/@aws-sdk|aws-sdk/i.test(allDeps)) infra.storage.push('aws');
    } catch (_e) {}
  }

  infra.databases = [...new Set(infra.databases)];
  infra.messaging = [...new Set(infra.messaging)];
  infra.services = [...new Set(infra.services)];
  infra.storage = [...new Set(infra.storage)];
  return infra;
}

function assessResilienceGaps(dir, infra) {
  const gaps = [];
  const exists = (p) => fs.existsSync(path.join(dir, p));

  if (infra.databases.length > 0 && !exists('backup') && !exists('scripts/backup')) {
    gaps.push({
      area: 'Backup',
      severity: 'critical',
      detail: 'Database detected but no backup scripts found',
    });
  }
  if (!infra.containerized) {
    gaps.push({
      area: 'Portability',
      severity: 'high',
      detail: 'No containerization - deployment is environment-dependent',
    });
  }
  if (!exists('.github/workflows') && !exists('.gitlab-ci.yml')) {
    gaps.push({
      area: 'Automation',
      severity: 'high',
      detail: 'No CI/CD - manual deployment increases recovery time',
    });
  }
  if (infra.databases.length > 0 && !infra.orchestrated) {
    gaps.push({
      area: 'High Availability',
      severity: 'medium',
      detail: 'Database without orchestration - no automatic failover',
    });
  }
  if (!exists('docs/disaster-recovery.md') && !exists('DR.md')) {
    gaps.push({
      area: 'Documentation',
      severity: 'medium',
      detail: 'No existing DR documentation',
    });
  }
  return gaps;
}

function generateRunbook(infra, gaps, rto, rpo) {
  const steps = [];
  let stepNum = 1;

  steps.push({
    step: stepNum++,
    phase: 'Detection',
    action: 'Confirm incident via monitoring alerts and status checks',
    duration: '5 min',
    responsible: 'On-call engineer',
  });
  steps.push({
    step: stepNum++,
    phase: 'Assessment',
    action: 'Determine scope: which services are affected',
    duration: '10 min',
    responsible: 'Incident commander',
  });
  steps.push({
    step: stepNum++,
    phase: 'Communication',
    action: 'Notify stakeholders and update status page',
    duration: '5 min',
    responsible: 'Incident commander',
  });

  if (infra.databases.length > 0) {
    steps.push({
      step: stepNum++,
      phase: 'Database Recovery',
      action: `Restore ${infra.databases.join(', ')} from latest backup (RPO: ${rpo}h)`,
      duration: '30-60 min',
      responsible: 'DBA / Backend engineer',
    });
  }

  if (infra.containerized) {
    steps.push({
      step: stepNum++,
      phase: 'Service Recovery',
      action: 'Redeploy containers from registry using docker-compose or k8s manifests',
      duration: '15-30 min',
      responsible: 'DevOps engineer',
    });
  } else {
    steps.push({
      step: stepNum++,
      phase: 'Service Recovery',
      action: 'Provision new infrastructure and deploy application',
      duration: '60-120 min',
      responsible: 'DevOps / Backend engineer',
    });
  }

  steps.push({
    step: stepNum++,
    phase: 'Verification',
    action: 'Run smoke tests and verify critical user journeys',
    duration: '15 min',
    responsible: 'QA engineer',
  });
  steps.push({
    step: stepNum++,
    phase: 'Post-mortem',
    action: 'Document timeline, root cause, and corrective actions',
    duration: '2-4 hours (post-recovery)',
    responsible: 'Incident commander',
  });

  const estimatedRecovery = steps.reduce((s, step) => {
    const m = (step.duration || '').match(/(\d+)/);
    return s + (m ? parseInt(m[1]) : 0);
  }, 0);

  return {
    steps,
    estimatedRecoveryMinutes: estimatedRecovery,
    meetsRTO: estimatedRecovery <= rto * 60,
  };
}

runSkill('disaster-recovery-planner', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const infra = detectInfrastructure(targetDir);
  const gaps = assessResilienceGaps(targetDir, infra);
  const runbook = generateRunbook(infra, gaps, argv.rto, argv.rpo);

  const result = {
    directory: targetDir,
    rtoHours: argv.rto,
    rpoHours: argv.rpo,
    infrastructure: infra,
    resilienceGaps: gaps,
    runbook: runbook.steps,
    estimatedRecoveryMinutes: runbook.estimatedRecoveryMinutes,
    meetsRTO: runbook.meetsRTO,
    gapCount: gaps.length,
    recommendations: gaps.map((g) => `[${g.severity}] ${g.area}: ${g.detail}`),
  };

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
