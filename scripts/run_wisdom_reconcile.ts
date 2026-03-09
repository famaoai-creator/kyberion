import { logger, safeReadFile, safeExec, safeWriteFile, rootResolve } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const adf = {
    action: 'reconcile',
    strategy_path: 'knowledge/governance/wisdom-reconcile-strategy.json'
  };

  logger.info('🧘 [WISDOM] Triggering Strategic Reconciliation...');
  const tempAdfPath = rootResolve(`scratch/reconcile-input-${Date.now()}.json`);
  safeWriteFile(tempAdfPath, JSON.stringify(adf));

  try {
    const output = safeExec('npx', ['tsx', 'libs/actuators/wisdom-actuator/src/index.ts', '--input', tempAdfPath]);
    console.log(output);
    logger.success('✅ Reconciliation job finished.');
  } catch (err: any) {
    logger.error(`❌ Reconciliation failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
  }
}

main();
