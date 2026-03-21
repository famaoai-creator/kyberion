/**
 * presence/bridge/reflex-host.ts
 * Kyberion Autonomic Reflex Host v1.0
 * [SECURE-IO COMPLIANT]
 * 
 * An interpreter that executes autonomic reactions defined in a Reflex ADF.
 */

import { logger, safeReadFile, pathResolver } from '@agent/core';
import { listenToNerve } from '@agent/core/nerve-bridge';
import { reflexEngine, type ReflexADF } from '@agent/shared-nerve';
import { handleAction as dispatchService } from '@actuator/service';
import * as path from 'node:path';

async function main() {
  const adfPath = process.argv[2];
  if (!adfPath) throw new Error('Usage: reflex-host.ts <path-to-reflex-adf>');

  const content = safeReadFile(path.resolve(process.cwd(), adfPath), { encoding: 'utf8' }) as string;
  const adf = JSON.parse(content) as ReflexADF;

  logger.info(`⚡ [ReflexHost] Activating autonomic reflex: ${adf.id}`);

  // Set context role for Shield compliance
  process.env.MISSION_ID = 'MSN-SYSTEM-REFLEX-HUB';
  process.env.MISSION_ROLE = 'infrastructure_sentinel';

  // Initialize engine with a concrete dispatcher
  reflexEngine.setDispatcher(async (actuator, action, params) => {
    if (actuator === 'service-actuator') {
      await dispatchService({
        service_id: params.service_id || 'slack',
        mode: 'API',
        action: action,
        params: params,
        auth: 'secret-guard'
      });
    } else {
      logger.warn(`⚠️ [Reflex] Actuator ${actuator} not yet supported in host.`);
    }
  });

  // Load specifically this ADF
  // (In a full implementation, the host might manage multiple ADFs)
  (reflexEngine as any).reflexes = [adf]; 

  // Listen to the nerve bus
  listenToNerve('reflex-host', async (stimulus) => {
    await reflexEngine.evaluate(stimulus);
  });
}

main().catch(err => {
  console.error(`CRITICAL: Reflex Host failed: ${err.message}`);
  process.exit(1);
});
