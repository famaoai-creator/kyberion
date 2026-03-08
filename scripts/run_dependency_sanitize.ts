import { handleAction } from '../libs/actuators/code-actuator/src/index';
import { logger } from '@agent/core';

async function main() {
  const policyPath = 'knowledge/governance/package-governance.json';
  
  const adf = {
    action: 'sanitize-deps',
    params: {
      policy_path: policyPath
    }
  };

  logger.info('📦 [ADF] Running Dependency Sanitization...');
  try {
    const result = await handleAction(adf as any);
    logger.success('✅ Dependency Sanitization Complete.');
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    logger.error(`❌ Sanitization Failed: ${err.message}`);
    process.exit(1);
  }
}

main();
