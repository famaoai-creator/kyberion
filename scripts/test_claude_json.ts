import { spawn } from 'node:child_process';
import { logger } from '../libs/core/index.js';

async function testClaudeJSON() {
  logger.info('🚀 Testing Claude Code JSON Streaming Mode...');

  // Use recommended OpenClaw-style flags
  const cp = spawn('npx', ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  cp.stdout.on('data', (d) => {
    logger.info(`[CLAUDE_OUT] ${d.toString().trim()}`);
  });

  cp.stderr.on('data', (d) => {
    logger.info(`[CLAUDE_ERR] ${d.toString().trim()}`);
  });

  // Give it a moment to boot
  await new Promise(r => setTimeout(r, 5000));

  // Try sending a JSON-formatted prompt if it expects stream-json
  // (This is a guess, might need a specific wrapping object)
  const prompt = JSON.stringify({
    type: 'prompt',
    payload: 'Hello Claude, list 3 colors. Reply in JSON if possible.'
  });

  logger.info(`Sending JSON Prompt: ${prompt}`);
  cp.stdin.write(`${prompt}\n`);

  await new Promise(r => setTimeout(r, 5000));
  cp.kill();
  logger.info('🏁 Claude test finished.');
}

testClaudeJSON().catch(console.error);
