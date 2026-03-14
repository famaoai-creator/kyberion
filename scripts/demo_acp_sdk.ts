import { ACPMediator, logger } from '../libs/core/index.js';

async function runACPSDKDemo() {
  logger.info('🚀 Starting SDK-powered ACP Mediation Demo (Model Selection)...');

  const mediator = new ACPMediator({
    threadId: 'acp-model-test-thread',
    bootCommand: 'gemini',
    bootArgs: ['--acp'],
    modelId: 'gemini-2.5-flash-lite' // Explicitly select a lightweight model
  });

  try {
    // 1. Boot and Handshake (includes model selection)
    await mediator.boot();
    logger.info('✅ ACP Handshake and Session creation complete.');

    // 2. Multi-turn conversation
    logger.info('Asking Question 1...');
    const resp1 = await mediator.ask('Please list 3 constellations.');
    logger.info(`[GEMINI_ACP_RESP_1]:\n${resp1}`);

    logger.info('Asking Question 2...');
    const resp2 = await mediator.ask('Which one is the easiest to find in the sky?');
    logger.info(`[GEMINI_ACP_RESP_2]:\n${resp2}`);

  } catch (err: any) {
    logger.error(`❌ ACP SDK Mediation failed: ${err.message}`);
    if (err.stack) logger.error(err.stack);
  } finally {
    await mediator.shutdown();
    logger.info('🏁 ACP SDK Demo complete.');
  }
}

runACPSDKDemo().catch(console.error);
