import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve, safeExistsSync, safeUnlinkSync } from '@agent/core';
import * as path from 'node:path';

async function main() {
  const configPath = rootResolve('knowledge/governance/knowledge-sync-rules.json');
  if (!safeExistsSync(configPath)) {
    logger.warn('Knowledge sync rules not found.');
    return;
  }
  const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
  
  for (const job of config.jobs || []) {
    logger.info(`🔄 [KNOWLEDGE] Running sync action: ${job.action}`);
    const tempAdfPath = rootResolve(`scratch/knowledge-sync-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('npx', ['tsx', 'libs/actuators/wisdom-actuator/src/index.ts', '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Knowledge sync ${job.action} failed: ${err.message}`);
    } finally {
      if (safeExistsSync(tempAdfPath)) safeUnlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
