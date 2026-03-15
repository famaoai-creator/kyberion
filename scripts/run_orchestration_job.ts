import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve, safeExistsSync, safeUnlinkSync, sharedTmp, capabilityEntry } from '@agent/core';

async function main() {
  let configPath = rootResolve('knowledge/governance/orchestration-config.json');
  if (!safeExistsSync(configPath)) {
    configPath = rootResolve('knowledge/public/governance/orchestration-config.json');
  }
  
  if (!safeExistsSync(configPath)) {
    logger.warn('Orchestration config not found.');
    return;
  }
  const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
  
  for (const job of config.jobs || []) {
    logger.info(`🚀 [ORCHESTRATION] Running job: ${job.name}`);
    const tempAdfPath = sharedTmp(`scripts/orchestration-job-${Date.now()}.json`);
    safeWriteFile(tempAdfPath, JSON.stringify(job));
    
    try {
      const output = safeExec('node', [capabilityEntry('orchestrator-actuator'), '--input', tempAdfPath]);
      console.log(output);
    } catch (err: any) {
      logger.error(`Orchestration job ${job.name} failed: ${err.message}`);
    } finally {
      if (safeExistsSync(tempAdfPath)) safeUnlinkSync(tempAdfPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
