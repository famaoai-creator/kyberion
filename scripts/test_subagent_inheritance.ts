import { handleAction as agentAction } from '../libs/actuators/agent-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

async function testAgentLifecycle() {
  logger.info('Testing Agent-Actuator lifecycle...');

  // 1. List agents (should be empty)
  const listResult: any = await agentAction({ action: 'list', params: {} });
  logger.info(`Agents before spawn: ${listResult.count}`);

  // 2. Health check
  const healthResult: any = await agentAction({ action: 'health', params: {} });
  logger.info(`Health: total=${healthResult.total}, ready=${healthResult.ready}`);

  logger.info('Agent-Actuator lifecycle test complete.');
}

testAgentLifecycle().catch(console.error);
