import { ptyEngine, logger } from '../libs/core/index.js';

async function testGeminiACPRawV2() {
  logger.info('🚀 Raw ACP Protocol Investigation (V2)...');

  const sessionId = ptyEngine.spawn('gemini', ['--acp'], process.cwd(), {});

  // 1. Wait for process to start and capture any initial text
  await new Promise(r => setTimeout(r, 2000));
  const initText = ptyEngine.poll(sessionId);
  logger.info(`[RAW_STARTUP_TEXT]:\n${initText.output}`);

  // 2. Send a few newlines to "wake up" the PTY listener
  logger.info('Sending newlines to wake up PTY...');
  ptyEngine.write(sessionId, '\r\n\r\n');
  await new Promise(r => setTimeout(r, 1000));

  // 3. Manually send the ACP Initialize Request
  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Kyberion', version: '1.0.0' }
    }
  });

  logger.info(`[SENDING_INIT]: ${initMsg}`);
  ptyEngine.write(sessionId, `${initMsg}\r\n`);

  // 4. Long poll for response (Wait up to 10 seconds)
  logger.info('Waiting for ACP response...');
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const res = ptyEngine.poll(sessionId);
    if (res.output) {
      logger.info(`[ACP_IN_CHUNK_${i}]:\n${res.output}`);
      if (res.output.includes('"result"') || res.output.includes('"id":1')) {
        logger.info('✅ Handshake Response Detected!');
        break;
      }
    }
  }

  // 5. Try a prompt regardless
  const promptMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'prompt',
    params: {
      content: [{ type: 'text', text: 'Hello! Are you there? Please reply in JSON.' }]
    }
  });
  logger.info(`[SENDING_PROMPT]: ${promptMsg}`);
  ptyEngine.write(sessionId, `${promptMsg}\r\n`);

  await new Promise(r => setTimeout(r, 5000));
  const finalRes = ptyEngine.poll(sessionId);
  logger.info(`[FINAL_RESULT]:\n${finalRes.output}`);

  ptyEngine.kill(sessionId);
}

testGeminiACPRawV2().catch(console.error);
