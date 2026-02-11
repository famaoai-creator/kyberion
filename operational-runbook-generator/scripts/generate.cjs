#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('service', { alias: 's', type: 'string', describe: 'Service name', demandOption: true })
  .option('type', { alias: 't', type: 'string', describe: 'Runbook type', choices: ['deploy', 'rollback', 'incident', 'scaling'], default: 'deploy' })
  .option('out', { alias: 'o', type: 'string', describe: 'Output file path' })
  .argv;

// --- Runbook Templates ---

const TEMPLATES = {
  deploy: {
    overview: (service) => `This runbook describes the standard deployment procedure for **${service}**. Follow each step in order and verify before proceeding.`,
    prerequisites: [
      'Ensure CI/CD pipeline is green on the target branch',
      'Verify staging environment has been tested and approved',
      'Confirm deployment window with the on-call team',
      'Back up current configuration and database state',
      'Ensure rollback artifacts are available',
    ],
    steps: [
      'Pull the latest approved release tag from the repository',
      'Run pre-deployment health checks on the target environment',
      'Deploy the new version using the standard deployment pipeline',
      'Run smoke tests against the newly deployed version',
      'Monitor error rates and latency for 15 minutes post-deploy',
      'Update the deployment log with version, timestamp, and deployer',
    ],
    rollback: [
      'If error rate exceeds 1% threshold, initiate rollback immediately',
      'Revert to the previous known-good version using the deployment pipeline',
      'Verify rollback success with smoke tests',
      'Notify the team via incident channel and create a post-mortem ticket',
    ],
    monitoring: [
      'Watch error rate dashboards for 30 minutes post-deploy',
      'Check application logs for unexpected exceptions',
      'Verify key business metrics (throughput, latency P99) remain within SLA',
      'Confirm no alerts have fired in the monitoring system',
    ],
    contacts: [
      'On-call engineer: See PagerDuty schedule',
      'Service owner: Check CODEOWNERS file',
      'Escalation: Engineering Manager on duty',
    ],
  },
  rollback: {
    overview: (service) => `This runbook describes the emergency rollback procedure for **${service}**. Use when a deployment has caused degradation.`,
    prerequisites: [
      'Confirm the issue is caused by the recent deployment',
      'Identify the last known-good version/tag',
      'Notify the on-call team that a rollback is in progress',
      'Ensure database migrations are backward-compatible',
    ],
    steps: [
      'Identify the exact version to roll back to from deployment logs',
      'Trigger rollback via the deployment pipeline with the target version',
      'Wait for rollback deployment to complete across all instances',
      'Run smoke tests to verify the rolled-back version is healthy',
      'Verify database state is consistent with the rolled-back version',
    ],
    rollback: [
      'If rollback itself fails, escalate immediately to the service owner',
      'Consider taking the service offline if data integrity is at risk',
      'Engage database team if migration rollback is required',
    ],
    monitoring: [
      'Monitor error rates to confirm they return to baseline',
      'Check for any data inconsistencies introduced during the failed deploy',
      'Verify all dependent services are functioning correctly',
    ],
    contacts: [
      'On-call engineer: See PagerDuty schedule',
      'Database team: #db-ops Slack channel',
      'Escalation: VP of Engineering',
    ],
  },
  incident: {
    overview: (service) => `This runbook provides the incident response procedure for **${service}**. Follow the steps to diagnose, mitigate, and resolve the incident.`,
    prerequisites: [
      'Acknowledge the incident in the alerting system',
      'Join the incident communication channel',
      'Assign an Incident Commander if severity is P1/P2',
      'Begin a timeline log of all actions taken',
    ],
    steps: [
      'Gather initial data: error messages, affected endpoints, user impact',
      'Check recent deployments and configuration changes',
      'Review application and infrastructure logs for root cause indicators',
      'Implement mitigation (rollback, feature flag, scaling, etc.)',
      'Verify mitigation has resolved or reduced the impact',
      'Communicate status updates every 15 minutes to stakeholders',
    ],
    rollback: [
      'If the incident was caused by a deployment, follow the Rollback runbook',
      'If caused by configuration change, revert to previous configuration',
      'If caused by infrastructure issue, engage the platform team',
    ],
    monitoring: [
      'Track Mean Time To Recovery (MTTR) from incident start',
      'Monitor affected metrics until they return to baseline for 30 minutes',
      'Confirm no secondary incidents have been triggered',
    ],
    contacts: [
      'Incident Commander: Rotating schedule in PagerDuty',
      'Communications lead: #incident-comms Slack channel',
      'Executive escalation: CTO office',
    ],
  },
  scaling: {
    overview: (service) => `This runbook describes the scaling procedure for **${service}**. Use when the service needs to handle increased load.`,
    prerequisites: [
      'Review current resource utilization metrics (CPU, memory, connections)',
      'Identify the scaling trigger (traffic spike, planned event, growth)',
      'Verify auto-scaling policies are configured and the limits are adequate',
      'Ensure budget approval for additional resource costs',
    ],
    steps: [
      'Determine target capacity based on expected load increase',
      'Update scaling configuration (replicas, instance size, or auto-scaling limits)',
      'Apply scaling changes via infrastructure-as-code pipeline',
      'Monitor instance provisioning and health check status',
      'Run load tests if scaling for a planned event',
      'Verify the service handles the target throughput without degradation',
    ],
    rollback: [
      'If scaling causes instability, reduce to the previous replica count',
      'Check for resource contention (database connections, external API limits)',
      'Investigate if the bottleneck is elsewhere in the dependency chain',
    ],
    monitoring: [
      'Monitor resource utilization on new instances for 30 minutes',
      'Check auto-scaling events to ensure no flapping (rapid scale up/down)',
      'Verify cost dashboards reflect expected resource usage',
      'Confirm latency and error rates are within SLA',
    ],
    contacts: [
      'Platform team: #platform-eng Slack channel',
      'Cost management: FinOps team',
      'Service owner: Check CODEOWNERS file',
    ],
  },
};

/**
 * Generate a markdown runbook from a template.
 */
function generateMarkdown(service, type, template) {
  const sections = [];
  const lines = [];

  lines.push(`# ${type.charAt(0).toUpperCase() + type.slice(1)} Runbook: ${service}`);
  lines.push('');
  lines.push(`> Generated on ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // Overview
  sections.push('Overview');
  lines.push('## Overview');
  lines.push('');
  lines.push(template.overview(service));
  lines.push('');

  // Prerequisites
  sections.push('Prerequisites');
  lines.push('## Prerequisites');
  lines.push('');
  template.prerequisites.forEach((item, i) => {
    lines.push(`${i + 1}. ${item}`);
  });
  lines.push('');

  // Steps
  sections.push('Steps');
  lines.push('## Steps');
  lines.push('');
  template.steps.forEach((item, i) => {
    lines.push(`${i + 1}. ${item}`);
  });
  lines.push('');

  // Rollback
  sections.push('Rollback');
  lines.push('## Rollback');
  lines.push('');
  template.rollback.forEach((item, i) => {
    lines.push(`${i + 1}. ${item}`);
  });
  lines.push('');

  // Monitoring
  sections.push('Monitoring');
  lines.push('## Monitoring');
  lines.push('');
  template.monitoring.forEach((item) => {
    lines.push(`- ${item}`);
  });
  lines.push('');

  // Contacts
  sections.push('Contacts');
  lines.push('## Contacts');
  lines.push('');
  template.contacts.forEach((item) => {
    lines.push(`- ${item}`);
  });
  lines.push('');

  return { sections, markdown: lines.join('\n') };
}

runSkill('operational-runbook-generator', () => {
  const service = argv.service;
  const type = argv.type || 'deploy';
  const template = TEMPLATES[type];

  if (!template) {
    throw new Error(`Unknown runbook type: ${type}. Valid types: deploy, rollback, incident, scaling`);
  }

  const { sections, markdown } = generateMarkdown(service, type, template);

  const result = {
    service,
    type,
    sections,
    markdown,
  };

  // Write output if --out provided
  if (argv.out) {
    const outPath = path.resolve(argv.out);
    fs.writeFileSync(outPath, markdown, 'utf8');
    result.outputPath = outPath;
  }

  return result;
});