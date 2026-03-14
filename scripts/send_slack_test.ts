import { handleAction } from '../libs/actuators/presence-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

async function sendSlackTest() {
  logger.info('🚀 Sending real Slack message test...');

  // Target channel ID provided by user or guessed (replace with actual channel ID if known)
  const channelId = 'C08EL9ALUKZ'; 

  const result = await handleAction({
    action: 'dispatch',
    params: {
      channel: channelId,
      mode: 'emitter',
      payload: { 
        text: '👋 こんにちは！Kyberion エージェントからのメッセージです。TPL (Terminal-Presence Lifecycle) の実機テストを開始します。' 
      }
    }
  });

  logger.info(`✅ Result: ${JSON.stringify(result)}`);
}

sendSlackTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
