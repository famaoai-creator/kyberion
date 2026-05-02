import { logger, rootResolve, safeExistsSync } from '@agent/core';
import { invokeActuatorWithTempInput } from './refactor/ephemeral-actuator-call.js';
import { readJsonFile } from './refactor/cli-input.js';

async function main() {
  const configPath = rootResolve('knowledge/governance/knowledge-sync-rules.json');
  if (!safeExistsSync(configPath)) {
    logger.warn('Knowledge sync rules not found.');
    return;
  }
  const config = readJsonFile(configPath);
  
  for (const job of config.jobs || []) {
    logger.info(`🔄 [KNOWLEDGE] Running sync action: ${job.action}`);
    try {
      const output = invokeActuatorWithTempInput('wisdom-actuator', job, 'knowledge-sync');
      console.log(output);
    } catch (err: any) {
      logger.error(`Knowledge sync ${job.action} failed: ${err.message}`);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
