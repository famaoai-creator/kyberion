import { logger, runSurfaceMessageConversation } from '@agent/core';

async function simulate() {
  process.env.KYBERION_PERSONA ||= 'ecosystem_architect';
  process.env.MISSION_ROLE ||= 'mission_controller';

  logger.info('🚀 Starting Telegram Flow Simulation...');
  logger.info('📥 Inbound Message: "Telegram連携を試して"');

  try {
    const result = await runSurfaceMessageConversation({
      surface: 'telegram',
      text: 'Telegram連携を試して',
      channel: '123456789',
      threadTs: 'telegram-demo-1',
      correlationId: 'demo-telegram-123',
      receivedAt: new Date().toISOString(),
      actorId: '987654321',
      senderAgentId: 'kyberion:telegram-bridge',
      agentId: 'telegram-surface-agent',
      delegationSummaryInstruction: 'Produce a concise Telegram reply. Use markdown if useful. Do not use A2A blocks.',
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
