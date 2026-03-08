import { safeExec, logger } from '@agent/core';
import * as path from 'node:path';

/**
 * scripts/run_mission_mgmt.ts
 * ADF-driven runner for Mission & Task Management.
 */

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.log('Usage: npx ts-node scripts/run_mission_mgmt.ts <input.json>');
    process.exit(1);
  }

  logger.info(`🚀 Running Mission Management Job: ${inputPath}`);
  
  try {
    // Call the orchestrator actuator
    safeExec('npx', ['ts-node', 'libs/actuators/orchestrator-actuator/src/index.ts', '--input', inputPath]);
    logger.success('✅ Mission Management Job completed.');
  } catch (err: any) {
    logger.error(`❌ Mission Management Job failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
