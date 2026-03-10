import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  let configPath = rootResolve('knowledge/governance/orchestration-config.json');
  if (!fs.existsSync(configPath)) {
    configPath = rootResolve('knowledge/public/governance/orchestration-config.json');
  }
  
  if (!fs.existsSync(configPath)) {
    logger.warn('Orchestration config not found.');
    return;
  }
  const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
  
  for (const job of config.jobs || []) {
    logger.info(`🚀 [ORCHESTRATION] Running job: ${job.name}`);
    const tempAdfPath = rootResolve(`scratch/orchestration-job-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['tsx', 'libs/actuators/orchestrator-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Orchestration job ${job.name} failed: ${err.message}`);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
