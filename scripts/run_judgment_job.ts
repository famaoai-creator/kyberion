/**
 * scripts/run_judgment_job.ts
 * ADF-driven runner for AI Judging & Analysis.
 */

import { logger, safeReadFile, safeWriteFile, safeExec, safeExistsSync, safeUnlinkSync } from '@agent/core';
import * as path from 'node:path';

async function main() {
  const adfPath = process.argv[2] || 'work/judgment-job.json';
  const fullAdfPath = path.isAbsolute(adfPath) ? adfPath : path.resolve(process.cwd(), adfPath);

  if (!safeExistsSync(fullAdfPath)) {
    logger.error(`ADF job file not found: ${fullAdfPath}`);
    process.exit(1);
  }

  const adf = JSON.parse(safeReadFile(fullAdfPath, { encoding: 'utf8' }) as string);
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
  const tempAdfPath = path.resolve(process.cwd(), `work/temp-sys-${Date.now()}.json`);
  safeWriteFile(tempAdfPath, JSON.stringify(input, null, 2));

  try {
    const output = safeExec('npx', ['tsx', 'libs/actuators/system-actuator/src/index.ts', '--input', tempAdfPath]);
    console.log(output);
  } catch (err: any) {
    logger.error(`Action ${input.action} failed: ${err.message}`);
  } finally {
    if (safeExistsSync(tempAdfPath)) safeUnlinkSync(tempAdfPath);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
