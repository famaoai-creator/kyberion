import { ptyEngine, logger } from '../libs/core/index.js';

async function testGeminiACPHandshake() {
  logger.info('🚀 Attempting ACP Initialize Handshake with Gemini...');

  const sessionId = ptyEngine.spawn('gemini', ['--acp'], process.cwd(), {});

  // Wait for spawn
  await new Promise(r => setTimeout(r, 1000));
  ptyEngine.poll(sessionId); // Clear any init noise

  // 1. Send initialize request (JSON-RPC 2.0 style as per ACP spec)
  const initRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: { name: 'Kyberion', version: '1.0.0' }
    }
  });

  logger.info(`Sending: ${initRequest}`);
  ptyEngine.write(sessionId, `${initRequest}\n`);

  // 2. Wait for response
  await new Promise(r => setTimeout(r, 3000));
  const result = ptyEngine.poll(sessionId);
  
  logger.info(`[ACP_INIT_RESPONSE]:\n${result.output}`);

  if (result.output.includes('result') || result.output.includes('capabilities')) {
    logger.info('✅ ACP Handshake Successful!');
    
    // 3. Try a prompt if initialized
    const promptRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompt',
      params: {
        text: 'Hello Gemini! Please reply with "ACP_ACTIVE".'
      }
    });
    
    logger.info(`Sending Prompt: ${promptRequest}`);
    ptyEngine.write(sessionId, `${promptRequest}\n`);
    
    await new Promise(r => setTimeout(r, 5000));
    const promptResult = ptyEngine.poll(sessionId);
    logger.info(`[ACP_PROMPT_RESPONSE]:\n${promptResult.output}`);
  } else {
    logger.warn('❌ ACP Handshake failed to get a valid JSON-RPC response.');
  }

  ptyEngine.kill(sessionId);
}

testGeminiACPHandshake().catch(console.error);
