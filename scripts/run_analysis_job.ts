/**
 * scripts/run_analysis_job.ts
 * ADF-driven runner for Strategic Analysis & Modeling.
 */

import { logger, safeReadFile, safeWriteFile, safeExec, safeExistsSync, safeUnlinkSync } from '@agent/core';
import * as path from 'node:path';

async function main() {
  const adfPath = process.argv[2] || 'work/analysis-job.json';
  const fullAdfPath = path.isAbsolute(adfPath) ? adfPath : path.resolve(process.cwd(), adfPath);

  if (!safeExistsSync(fullAdfPath)) {
    logger.error(`ADF job file not found: ${fullAdfPath}`);
    process.exit(1);
  }

  const adf = JSON.parse(safeReadFile(fullAdfPath, { encoding: 'utf8' }) as string);
  const actions = adf.actions || ['all'];

  logger.info(`🚀 Starting Analysis Job: ${adf.job_id} (Mission: ${adf.mission_id || 'N/A'})`);

  for (const action of actions) {
    if (action === 'all') {
      // Execute standard analysis sequence
      await runModelingActuator({ ...adf, action: 'analyze', analysisType: 'skill_cooccurrence' });
      await runModelingActuator({ ...adf, action: 'analyze', analysisType: 'knowledge_graph' });
      continue;
    }
    
    // If it's a specific analysisType in the ADF, we pass it
    const analysisType = adf.analysisType || action;
    await runModelingActuator({ ...adf, action: 'analyze', analysisType });
  }

  logger.success('✅ Analysis Job completed.');
}

async function runModelingActuator(input: any) {
  const tempAdfPath = path.resolve(process.cwd(), `work/temp-mod-${Date.now()}.json`);
  safeWriteFile(tempAdfPath, JSON.stringify(input, null, 2));

  try {
    const output = safeExec('npx', ['tsx', 'libs/actuators/modeling-actuator/src/index.ts', '--input', tempAdfPath]);
    console.log(output);
  } catch (err: any) {
    logger.error(`Action ${input.analysisType || input.action} failed: ${err.message}`);
  } finally {
    if (safeExistsSync(tempAdfPath)) safeUnlinkSync(tempAdfPath);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
