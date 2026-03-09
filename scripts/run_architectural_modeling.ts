import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const jobs = [
    { action: 'graph', name: 'Generate Dependency Graph' },
    { action: 'parse_nonfunctional', name: 'Parse Non-Functional Reqs' }
  ];
  
  for (const job of jobs) {
    logger.info(`🚀 [MODELING] Running architectural job: ${job.name}`);
    const tempAdfPath = rootResolve(`scratch/modeling-job-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['ts-node', 'libs/actuators/modeling-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Modeling job ${job.name} failed: ${err.message}`);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
