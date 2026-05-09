import { installReasoningBackends, getReasoningBackend, logger } from '@agent/core';

async function test() {
  logger.info('--- Initializing Native Gemini CLI Backend ---');
  // Install the reasoning backend forcing gemini-cli mode
  const installed = installReasoningBackends({ mode: 'gemini-cli' });
  
  if (!installed) {
    logger.error('Failed to install gemini-cli backend');
    process.exit(1);
  }

  const backend = getReasoningBackend();

  logger.info('--- Delegating Task via Native invoke_agent ---');
  try {
    const result = await backend.delegateTask('「こんにちは」と返事をしてください。他の言葉は不要です。');
    logger.info('\n--- Sub-agent Result ---');
    console.log(result);
  } catch (err) {
    logger.error(`Error during delegation: ${err.message}`);
  }
}

test();
