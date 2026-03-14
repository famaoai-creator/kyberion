import { spawn } from 'node:child_process';
import { logger } from '../libs/core/index.js';

async function testCodexACP() {
  logger.info('🚀 Testing Codex experimental app-server...');

  const cp = spawn('npx', ['codex', 'app-server'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  cp.stdout?.on('data', (d) => {
    logger.info(`[CODEX_OUT] ${d.toString().trim()}`);
  });

  cp.stderr?.on('data', (d) => {
    logger.info(`[CODEX_ERR] ${d.toString().trim()}`);
  });

  await new Promise(r => setTimeout(r, 3000));

  // Try sending an ACP-style initialize message
  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { capabilities: {}, clientInfo: { name: 'Kyberion', version: '1.0.0' } }
  });

  logger.info(`Sending Handshake to Codex: ${initMsg}`);
  cp.stdin?.write(`${initMsg}\n`);

  await new Promise(r => setTimeout(r, 3000));
  cp.kill();
  logger.info('🏁 Codex test finished.');
}

testCodexACP().catch(console.error);
