import { handleAction } from '../libs/actuators/service-actuator/src/index';
import * as path from 'node:path';
import { logger } from '@agent/core';

async function main() {
  const manifestPath = 'knowledge/governance/active-services.json';
  
  const adf = {
    service_id: 'system',
    mode: 'RECONCILE',
    action: 'reconcile',
    params: {
      manifest_path: manifestPath,
      cleanup: true
    }
  };

  logger.info('🛡️ [ADF] Running Service Reconciliation...');
  try {
    const result = await handleAction(adf as any);
    logger.success('✅ Service Reconciliation Complete.');
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    logger.error(`❌ Reconciliation Failed: ${err.message}`);
    process.exit(1);
  }
}

main();
