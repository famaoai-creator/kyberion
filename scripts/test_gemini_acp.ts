import { ptyEngine, logger } from '../libs/core/index.js';

async function testGeminiACP() {
  logger.info('🚀 Testing Gemini in --acp mode...');

  const sessionId = ptyEngine.spawn('gemini', ['--acp'], process.cwd(), {});

  await new Promise(r => setTimeout(r, 2000));
  const initResult = ptyEngine.poll(sessionId);
  logger.info(`[ACP_INIT_RAW]:\n${JSON.stringify(initResult, null, 2)}`);

  logger.info('Sending test query to ACP...');
  ptyEngine.write(sessionId, 'Hello?\n');
  
  await new Promise(r => setTimeout(r, 2000));
  const respResult = ptyEngine.poll(sessionId);
  logger.info(`[ACP_RESPONSE_RAW]:\n${JSON.stringify(respResult, null, 2)}`);

  ptyEngine.kill(sessionId);
}

testGeminiACP().catch(console.error);
