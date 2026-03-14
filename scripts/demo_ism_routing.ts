import { handleAction as terminal } from '../libs/actuators/terminal-actuator/src/index.js';
import { handleAction as presence } from '../libs/actuators/presence-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

async function testISMRouting() {
  logger.info('🚀 Testing Cognitive Routing (ISM) Demo...');

  const threadId = 'routing-thread-123';

  // 1. Spawn a session associated with a logical thread
  const { sessionId } = await terminal({
    action: 'spawn',
    params: { threadId, shell: '/bin/sh' }
  });
  logger.info(`✅ Thread ${threadId} initialized.`);

  // 2. Dispatch messages to different personas via Presence
  logger.info('Dispatching messages to different personas...');
  
  // Message for KYBERION-PRIME
  await presence({
    action: 'dispatch',
    params: {
      channel: 'slack', mode: 'emitter',
      payload: { 
        threadId, 
        from: 'famao', 
        targetPersona: 'KYBERION-PRIME', 
        text: 'Prime, please review the latest logs.' 
      }
    }
  });

  // Message for Subagent-A
  await presence({
    action: 'dispatch',
    params: {
      channel: 'slack', mode: 'emitter',
      payload: { 
        threadId, 
        from: 'famao', 
        targetPersona: 'Subagent-A', 
        text: 'Subagent-A, focus on the security audit.' 
      }
    }
  });

  // Broadcast message
  await presence({
    action: 'dispatch',
    params: {
      channel: 'slack', mode: 'emitter',
      payload: { 
        threadId, 
        from: 'famao', 
        targetPersona: '*', 
        text: 'Attention everyone: System reboot in 5 mins.' 
      }
    }
  });

  // 3. Poll as KYBERION-PRIME
  logger.info('Polling as KYBERION-PRIME...');
  const primeResult = await terminal({
    action: 'poll',
    params: { sessionId, threadId, persona: 'KYBERION-PRIME' }
  });
  logger.info(`PRIME received ${primeResult.messages.length} messages.`);
  primeResult.messages.forEach((m: any) => logger.info(`  - From ${m.from}: "${m.payload}"`));

  // 4. Poll as Subagent-A
  logger.info('Polling as Subagent-A...');
  const subResult = await terminal({
    action: 'poll',
    params: { sessionId, threadId, persona: 'Subagent-A' }
  });
  logger.info(`Subagent-A received ${subResult.messages.length} messages.`);
  subResult.messages.forEach((m: any) => logger.info(`  - From ${m.from}: "${m.payload}"`));

  // 5. Poll again as PRIME (should be empty except for new broadcasts)
  logger.info('Polling again as PRIME...');
  const primeResult2 = await terminal({
    action: 'poll',
    params: { sessionId, threadId, persona: 'KYBERION-PRIME' }
  });
  logger.info(`PRIME received ${primeResult2.messages.length} new messages.`);

  // Cleanup
  await terminal({ action: 'kill', params: { sessionId } });
  logger.info('🏁 ISM Routing test complete.');
}

testISMRouting().catch(console.error);
