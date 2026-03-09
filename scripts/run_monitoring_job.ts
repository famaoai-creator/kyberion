import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const configPath = rootResolve('knowledge/governance/monitoring-rules.json');
  if (!fs.existsSync(configPath)) {
    logger.warn('Monitoring rules not found.');
    return;
  }
  const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
  
  for (const job of config.jobs || []) {
    logger.info(`📊 [MONITORING] Running monitoring action: ${job.action}`);
    const tempAdfPath = rootResolve(`scratch/monitoring-job-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['ts-node', 'libs/actuators/system-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Monitoring job ${job.action} failed: ${err.message}`);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
