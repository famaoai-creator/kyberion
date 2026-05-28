import { runSurfaceMessageConversation, logger } from '@agent/core';

async function simulate() {
  logger.info('🚀 Starting iMessage Flow Simulation...');
  logger.info('📥 Inbound Message: "来週の月曜日の予定を教えて"');

  try {
    const result = await runSurfaceMessageConversation({
      surface: 'imessage',
      text: '来週の月曜日の予定を教えて',
      channel: 'chat123',
      threadTs: 'msg456',
      correlationId: 'demo-123',
      receivedAt: new Date().toISOString(),
      actorId: '+81-XX-XXXX-XXXX',
      senderAgentId: 'kyberion:imessage-bridge',
      agentId: 'imessage-surface-agent',
      delegationSummaryInstruction: 'Produce a concise iMessage reply in the user language. Do not use A2A blocks.'
    } as any);

    logger.success('✅ Conversation logic completed.');
    logger.info('📤 Response Text:');
    console.log('\n' + result.text + '\n');
    
    if (result.a2uiMessages?.length) {
      logger.info(`✨ Generated ${result.a2uiMessages.length} A2UI blocks.`);
    }
  } catch (error: any) {
    logger.error(`❌ Simulation failed: ${error.message}`);
    if (error.stack) console.error(error.stack);
  }
}

simulate();
