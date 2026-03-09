import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const configPath = rootResolve('knowledge/governance/knowledge-sync-rules.json');
  if (!fs.existsSync(configPath)) {
    logger.warn('Knowledge sync rules not found.');
    return;
  }
  const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
  
  for (const job of config.jobs || []) {
    logger.info(`🔄 [KNOWLEDGE] Running sync action: ${job.action}`);
    const tempAdfPath = rootResolve(`scratch/knowledge-sync-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['ts-node', 'libs/actuators/wisdom-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Knowledge sync ${job.action} failed: ${err.message}`);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
