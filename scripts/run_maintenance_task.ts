/**
 * scripts/run_maintenance_task.ts
 * ADF-Driven Maintenance Task Runner
 */

import { logger, safeReadFile, safeWriteFile, safeExec } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

const rootDir = process.cwd();

async function main() {
  logger.info('🚀 [ADF] Starting Maintenance Task...');

  const schedulePath = path.join(rootDir, 'knowledge/governance/maintenance-schedule.json');
  if (!fs.existsSync(schedulePath)) {
    logger.error('Maintenance schedule not found.');
    process.exit(1);
  }

  const schedule = JSON.parse(safeReadFile(schedulePath, { encoding: 'utf8' }) as string);
  
  const input = {
    action: 'maintain',
    params: {
      scope: schedule.scope || 'all',
      tasks: schedule.default_tasks || [],
      policy_path: schedule.policy_path
    }
  };

  const inputPath = path.join(rootDir, 'work/maintenance_input.json');
  if (!fs.existsSync(path.dirname(inputPath))) {
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  }
  safeWriteFile(inputPath, JSON.stringify(input, null, 2));

  try {
    const actuatorPath = 'libs/actuators/code-actuator/src/index.ts';
    // We use ts-node to run the actuator for now, or it could be a built version.
    const result = safeExec('npx', ['tsx', 'libs/actuators/code-actuator/src/index.ts', '--input', inputPath]);
    console.log(result);
    logger.success('✅ [ADF] Maintenance Task Completed.');
  } catch (err: any) {
    logger.error(`❌ [ADF] Maintenance Task Failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
