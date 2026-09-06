import { logger } from '@agent/core/core';
import { runSurfaceMessageConversation } from '@agent/core/surface-runtime-orchestrator';
import { nowIso } from '@agent/core/foundation';
import { currentProcessArgv, defineScript, isDirectScript } from '../lib/harness.js';

export const simulateIMessage = defineScript({
  name: 'imessage-demo',
  async run({ print }) {
    logger.info('🚀 Starting iMessage Flow Simulation...');
    logger.info('📥 Inbound Message: "来週の月曜日の予定を教えて"');

    const result = await runSurfaceMessageConversation({
      surface: 'imessage',
      text: '来週の月曜日の予定を教えて',
      locale: 'ja',
      channel: 'chat123',
      threadTs: 'msg456',
      correlationId: 'demo-123',
      receivedAt: nowIso(),
      actorId: '+81-XX-XXXX-XXXX',
      senderAgentId: 'kyberion:imessage-bridge',
      agentId: 'imessage-surface-agent',
      delegationSummaryInstruction:
        'Produce a concise iMessage reply in the user language. Do not use A2A blocks.',
    });

    logger.success('✅ Conversation logic completed.');
    logger.info('📤 Response Text:');
    print('\n' + result.text + '\n');

    if (result.a2uiMessages?.length) {
      logger.info(`✨ Generated ${result.a2uiMessages.length} A2UI blocks.`);
    }
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'demo_imessage_flow.ts') ||
  isDirectScript(import.meta.url, 'demo_imessage_flow.js')
)
  void simulateIMessage(currentProcessArgv().slice(2));
