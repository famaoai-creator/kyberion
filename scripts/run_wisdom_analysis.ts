import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const jobs = [
    { action: 'git_summary', name: 'Git Commit Summary' },
    { action: 'cloud_cost', name: 'Cloud Cost Estimation', options: { resources: [
      { name: 'API Server', type: 'compute', size: 'medium', count: 2 },
      { name: 'Core DB', type: 'database', size: 'large', count: 1 }
    ] } },
    { action: 'suggest_skill', name: 'Suggest New Skills', options: { intent: 'security-audit' } }
  ];
  
  for (const job of jobs) {
    logger.info(`🧠 [WISDOM] Running analysis job: ${job.name}`);
    const tempAdfPath = rootResolve(`scratch/wisdom-job-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['ts-node', 'libs/actuators/wisdom-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Wisdom job ${job.name} failed: ${err.message}`);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
