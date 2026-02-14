#!/usr/bin/env node
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const fs = require('fs');
const path = require('path');

/**
 * Chaos Monkey Orchestrator
 * Injects artificial faults into the ecosystem to test resilience.
 */

const argv = createStandardYargs()
  .option('target', { alias: 't', type: 'string', description: 'Target skill to disrupt' })
  .option('mode', {
    alias: 'm',
    type: 'string',
    choices: ['latency', 'error', 'memory-spike'],
    default: 'latency',
  })
  .option('intensity', {
    type: 'number',
    default: 0.5,
    description: 'Probability of failure (0.0 - 1.0)',
  }).argv;

runSkill('chaos-monkey-orchestrator', () => {
  const configPath = path.resolve(process.cwd(), 'work/chaos-config.json');

  const config = {
    active: true,
    target: argv.target || '*',
    mode: argv.mode,
    intensity: argv.intensity,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    status: 'chaos_deployed',
    config,
    message: `Chaos Monkey is now haunting ${argv.target || 'all skills'} with ${argv.mode} (p=${argv.intensity}).`,
  };
});
