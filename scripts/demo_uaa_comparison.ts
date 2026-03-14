import { AgentFactory, logger } from '../libs/core/index.js';

async function runComparison() {
  const providers: ('gemini' | 'codex')[] = ['codex', 'gemini'];

  for (const provider of providers) {
    logger.info(`\n🚀 --- Testing Provider: ${provider.toUpperCase()} ---`);
    const agent = AgentFactory.create(provider);

    try {
      await agent.boot();
      logger.info(`[${provider}] Boot successful.`);

      const response = await agent.ask('What is the capital of France?');
      logger.info(`[${provider}] Response: ${response.text}`);
      if (response.thought) {
        logger.info(`[${provider}] Thought: ${response.thought.substring(0, 100)}...`);
      }

    } catch (err: any) {
      logger.error(`[${provider}] Failed: ${err.message}`);
    } finally {
      await agent.shutdown();
    }
  }
}

runComparison().catch(console.error);
