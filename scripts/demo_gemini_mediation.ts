import { AgentMediator, logger } from '../libs/core/index.js';

async function runGeminiMediationInteractive() {
  logger.info('🚀 Starting REAL Gemini Mediation (Persistent Interactive Mode)...');

  // Interactive mode: NO -p. 
  // We use promptPattern to detect when Gemini is ready for next input.
  const mediator = new AgentMediator({
    threadId: 'gemini-interactive-thread',
    promptPattern: '> ', 
    bootCommand: 'gemini',
    bootArgs: ['-o', 'text'], // Try to force text-ish output even in TUI
    timeoutMs: 60000
  });

  try {
    // 1. Boot Gemini and wait for initial prompt
    logger.info('Booting Gemini...');
    await mediator.boot();
    logger.info('[MEDIATOR] Gemini is ready.');

    // 2. First Question
    logger.info('Asking Question 1...');
    const resp1 = await mediator.ask('Please list 3 fruits. Output only the names.\r');
    logger.info(`[GEMINI_INTERACTIVE_RESP_1]:\n${resp1}`);

    // 3. Second Question (Maintaining context)
    logger.info('Asking Question 2 (Context check)...');
    const resp2 = await mediator.ask('Now add 2 vegetables to that list.\r');
    logger.info(`[GEMINI_INTERACTIVE_RESP_2]:\n${resp2}`);

  } catch (err: any) {
    logger.error(`❌ Interactive mediation failed: ${err.message}`);
  } finally {
    await mediator.shutdown();
    logger.info('🏁 Gemini Interactive Demo complete.');
  }
}

runGeminiMediationInteractive().catch(console.error);
