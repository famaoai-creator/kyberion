import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const jobs = [
    { action: 'deploy', name: 'Standard Redeployment' }
  ];
  
  for (const job of jobs) {
    logger.info(`🚀 [ORCHESTRATOR] Running healing/ops job: ${job.name}`);
    const tempAdfPath = rootResolve(`scratch/ops-job-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['ts-node', 'libs/actuators/orchestrator-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Ops job ${job.name} failed: ${err.message}`);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
