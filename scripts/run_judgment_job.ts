/**
 * scripts/run_judgment_job.ts
 * ADF-driven runner for AI Judging & Analysis.
 */

import { logger, safeExistsSync, pathResolver } from '@agent/core';
import * as path from 'node:path';
import { invokeActuatorWithTempInput } from './refactor/ephemeral-actuator-call.js';
import { readJsonFile } from './refactor/cli-input.js';

async function main() {
  const adfPath = process.argv[2] || 'work/judgment-job.json';
  const fullAdfPath = path.isAbsolute(adfPath) ? adfPath : path.resolve(pathResolver.rootDir(), adfPath);

  if (!safeExistsSync(fullAdfPath)) {
    logger.error(`ADF job file not found: ${fullAdfPath}`);
    process.exit(1);
  }

  const adf = readJsonFile(fullAdfPath);
  const actions = adf.actions || ['all'];

  logger.info(`🚀 Starting AI Judgment Job: ${adf.job_id} (Mission: ${adf.mission_id})`);

  for (const action of actions) {
    let subAction = action;
    if (action === 'all') {
      // Execute standard sequence
      await runSystemActuator({ ...adf, action: 'judge' });
      await runSystemActuator({ ...adf, action: 'ace_consensus' });
      await runSystemActuator({ ...adf, action: 'alignment_mirror' });
      continue;
    }
    await runSystemActuator({ ...adf, action: subAction });
  }

  logger.success('✅ AI Judgment Job completed.');
}

async function runSystemActuator(input: any) {
  try {
    const output = invokeActuatorWithTempInput('system-actuator', input, 'temp-sys');
    console.log(output);
  } catch (err: any) {
    logger.error(`Action ${input.action} failed: ${err.message}`);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
