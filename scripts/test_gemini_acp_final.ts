import { ptyEngine, logger } from '../libs/core/index.js';

async function testGeminiACPFinal() {
  logger.info('🚀 Final Attempt: Gemini --acp via PTY with JSON frames...');

  // Spawn gemini in acp mode
  const sessionId = ptyEngine.spawn('gemini', ['--acp'], process.cwd(), {});

  // 1. Wait for initial setup
  await new Promise(r => setTimeout(r, 2000));
  ptyEngine.poll(sessionId); // Clear init noise

  // 2. Send an ACP-style query (guessing the protocol based on acp-cli standards)
  // Usually it's a JSON line.
  const query = JSON.stringify({
    type: 'run',
    payload: {
      prompt: 'Hello, are you in ACP mode? Respond with "ACP_CONFIRMED" if yes.'
    }
  });

  logger.info(`Sending ACP Frame: ${query}`);
  ptyEngine.write(sessionId, `${query}\n`);

  // 3. Wait for response
  // We expect a JSON response back.
  await new Promise(r => setTimeout(r, 5000));
  const result = ptyEngine.poll(sessionId);
  
  logger.info(`[ACP_RESULT_RAW]:\n${result.output}`);

  if (result.output.includes('ACP_CONFIRMED') || result.output.includes('{')) {
    logger.info('✅ ACP Protocol communication established!');
  } else {
    logger.warn('❌ Still getting plain text or no response. gemini --acp may require specific headers.');
  }

  ptyEngine.kill(sessionId);
}

testGeminiACPFinal().catch(console.error);
