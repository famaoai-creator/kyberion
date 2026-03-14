import { handleAction as terminalAction } from '../libs/actuators/terminal-actuator/src/index.js';
import { handleAction as subagentAction } from '../libs/actuators/subagent-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

async function testSubagentInheritance() {
  logger.info('🚀 Testing Subagent Context Inheritance...');

  // 1. Parent works in terminal
  const { sessionId: parentSessionId } = await terminalAction({
    action: 'spawn',
    params: { shell: '/bin/sh' }
  });
  
  logger.info('Parent is performing complex tasks...');
  await terminalAction({
    action: 'write',
    params: { sessionId: parentSessionId, data: 'echo "CONFIG_LOADED=true"\r' }
  });
  await terminalAction({
    action: 'write',
    params: { sessionId: parentSessionId, data: 'ls -la\r' }
  });

  await new Promise(r => setTimeout(r, 500));

  // 2. Delegate a sub-task to a Sub-agent
  logger.info('Delegating analysis to sub-agent...');
  const result = await subagentAction({
    action: 'spawn',
    params: {
      parentSessionId,
      task: 'Analyze the directory structure and configuration status.',
      role: 'Security Auditor'
    }
  });

  logger.info(`✅ Sub-agent spawned with ID: ${result.subMissionId}`);
  logger.info(`[VERIFICATION] Inherited Context Snippet:\n${result.inheritedContext}`);

  // 3. Cleanup
  await terminalAction({ action: 'kill', params: { sessionId: parentSessionId } });
  logger.info('✅ Subagent Inheritance test complete.');
}

testSubagentInheritance().catch(console.error);
