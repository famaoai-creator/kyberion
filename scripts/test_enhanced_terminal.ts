import { handleAction } from '../libs/actuators/terminal-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

async function testEnhancedTerminal() {
  logger.info('🚀 Testing Enhanced Terminal-Actuator...');

  // 1. Spawn
  const { sessionId } = await handleAction({
    action: 'spawn',
    params: { shell: '/bin/sh' }
  });
  logger.info(`✅ Session created: ${sessionId}`);

  // 2. Test Symbolic Keys (ls + Enter)
  logger.info('Testing symbolic keys: ["ls", "Enter"]');
  await handleAction({
    action: 'write',
    params: { sessionId, keys: ['l', 's', 'enter'] }
  });

  await new Promise(r => setTimeout(r, 500));

  // 3. Test Log Slicing (Polling with limit)
  logger.info('Testing log slicing: limit 10');
  const slice1 = await handleAction({
    action: 'poll',
    params: { sessionId, offset: 0, limit: 10 }
  });
  logger.info(`Slice 1 (0-10): "${slice1.output}" (Total: ${slice1.total})`);

  const slice2 = await handleAction({
    action: 'poll',
    params: { sessionId, offset: 10, limit: 10 }
  });
  logger.info(`Slice 2 (10-20): "${slice2.output}"`);

  // 4. Test Full Drain (Backward compatibility)
  logger.info('Testing full drain (offset undefined)');
  const full = await handleAction({
    action: 'poll',
    params: { sessionId }
  });
  logger.info(`Full Drain Output Length: ${full.output.length}`);

  // 5. Cleanup
  await handleAction({ action: 'kill', params: { sessionId } });
  logger.info('✅ Enhanced Terminal-Actuator test complete.');
}

testEnhancedTerminal().catch(console.error);
