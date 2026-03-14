import { handleAction } from '../libs/actuators/terminal-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

async function testLogicalThreading() {
  logger.info('🚀 Testing Logical Threading Concept...');

  const myThreadId = 'shared-dev-env-001';

  // 1. Mission A: Initialize environment in the thread
  logger.info('Mission A: Starting and setting up environment...');
  const { sessionId: idA } = await handleAction({
    action: 'spawn',
    params: { threadId: myThreadId, shell: '/bin/sh' }
  });

  await handleAction({
    action: 'write',
    params: { sessionId: idA, data: 'mkdir -p /tmp/kyberion-test && cd /tmp/kyberion-test && export MISSION_TAG=Alpha\r' }
  });
  await new Promise(r => setTimeout(r, 500));
  logger.info('Mission A: Setup complete.');

  // 2. Mission B: Attach to the same thread and verify state
  logger.info('Mission B: Attaching to the same thread...');
  const { sessionId: idB } = await handleAction({
    action: 'spawn',
    params: { threadId: myThreadId }
  });

  if (idA === idB) {
    logger.info('✅ Mission B correctly attached to the same physical session.');
  }

  logger.info('Mission B: Verifying inherited state (pwd and env)...');
  await handleAction({
    action: 'write',
    params: { sessionId: idB, data: 'pwd && echo "Tag is: $MISSION_TAG"\r' }
  });

  await new Promise(r => setTimeout(r, 500));
  const { output } = await handleAction({ action: 'poll', params: { sessionId: idB } });
  
  logger.info(`[THREAD_VERIFICATION]:\n${output}`);

  if (output.includes('/tmp/kyberion-test') && output.includes('Tag is: Alpha')) {
    logger.info('✅ Logical Threading confirmed: State was preserved across attachments.');
  }

  // 3. Cleanup
  await handleAction({ action: 'kill', params: { sessionId: idA } });
  logger.info('✅ Logical Threading test complete.');
}

testLogicalThreading().catch(console.error);
