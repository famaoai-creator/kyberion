import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const jobs = [
    { action: 'audit_report', name: 'Generate Audit Report' },
    { action: 'detect_stack', name: 'Detect Tech Stack' },
    { action: 'ledger_maestro', name: 'Verify Ledger Integrity', options: { action: 'verify' } },
    { action: 'voice_report', name: 'Voice Status Report', text: 'Kyberion system utilities are operational.' }
  ];
  
  for (const job of jobs) {
    logger.info(`🛠️ [SYSTEM] Running utility job: ${job.name}`);
    const tempAdfPath = rootResolve(`scratch/system-job-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['ts-node', 'libs/actuators/system-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`System job ${job.name} failed: ${err.message}`);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
