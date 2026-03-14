import { ptyEngine, logger } from '../libs/core/index.js';

async function testGeminiACPComplex() {
  logger.info('🚀 Advanced ACP Handshake Test...');

  const sessionId = ptyEngine.spawn('gemini', ['--acp'], process.cwd(), {});
  await new Promise(r => setTimeout(r, 1000));
  ptyEngine.poll(sessionId);

  // 1. Try JSON-RPC via NDJSON (Newline Delimited)
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05', // Try a specific version if needed
      capabilities: {},
      clientInfo: { name: 'Kyberion', version: '1.0.0' }
    }
  });

  logger.info('Attempting NDJSON style...');
  ptyEngine.write(sessionId, `${msg}\n`);
  
  await new Promise(r => setTimeout(r, 2000));
  let res = ptyEngine.poll(sessionId);
  logger.info(`NDJSON Result: ${res.output}`);

  if (!res.output) {
    // 2. Try LSP Style (Content-Length)
    logger.info('Attempting LSP (Content-Length) style...');
    const lspMsg = `Content-Length: ${Buffer.byteLength(msg, 'utf8')}\r\n\r\n${msg}`;
    ptyEngine.write(sessionId, lspMsg);
    
    await new Promise(r => setTimeout(r, 2000));
    res = ptyEngine.poll(sessionId);
    logger.info(`LSP Result: ${res.output}`);
  }

  ptyEngine.kill(sessionId);
}

testGeminiACPComplex().catch(console.error);
