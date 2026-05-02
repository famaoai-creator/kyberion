import { logger, rootResolve, safeExistsSync } from '@agent/core';
import { invokeActuatorWithTempInput } from './refactor/ephemeral-actuator-call.js';
import { readJsonFile } from './refactor/cli-input.js';

async function main() {
  let configPath = rootResolve('knowledge/governance/orchestration-config.json');
  if (!safeExistsSync(configPath)) {
    configPath = rootResolve('knowledge/public/governance/orchestration-config.json');
  }
  
  if (!safeExistsSync(configPath)) {
    logger.warn('Orchestration config not found.');
    return;
  }
  const config = readJsonFile(configPath);
  
  for (const job of config.jobs || []) {
    logger.info(`🚀 [ORCHESTRATION] Running job: ${job.name}`);
    try {
      const output = invokeActuatorWithTempInput('orchestrator-actuator', job, 'orchestration-job');
      console.log(output);
    } catch (err: any) {
      logger.error(`Orchestration job ${job.name} failed: ${err.message}`);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
