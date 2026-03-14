import { handleAction } from '../libs/actuators/terminal-actuator/src/index.js';
import { logger } from '../libs/core/index.js';

/**
 * Terminal-Actuator Prototype Demo
 * Simulates a multi-step interactive session.
 */

async function runDemo() {
  logger.info('🚀 Starting Terminal-Actuator Prototype Demo...');

  // 1. Spawn a shell
  const spawnResult = await handleAction({
    action: 'spawn',
    params: { shell: process.platform === 'win32' ? 'powershell.exe' : 'zsh', args: ['-l'] }
  });
  const sessionId = spawnResult.sessionId;
  logger.info(`✅ Spawned session: ${sessionId}`);

  // Wait for shell prompt
  await new Promise(r => setTimeout(r, 1000));
  const initialOutput = await handleAction({ action: 'poll', params: { sessionId } });
  logger.info(`[SHELL_INIT]:\n${initialOutput.output}`);

  // 2. Write a command (ls)
  logger.info('Writing command: ls -F');
  await handleAction({
    action: 'write',
    params: { sessionId, data: 'ls -F\r' }
  });

  // Wait for output
  await new Promise(r => setTimeout(r, 500));
  const lsOutput = await handleAction({ action: 'poll', params: { sessionId } });
  logger.info(`[LS_RESULT]:\n${lsOutput.output}`);

  // 3. Write another command (cat package.json)
  logger.info('Writing command: cat package.json | head -n 5');
  await handleAction({
    action: 'write',
    params: { sessionId, data: 'cat package.json | head -n 5\r' }
  });

  // Wait for output
  await new Promise(r => setTimeout(r, 500));
  const catOutput = await handleAction({ action: 'poll', params: { sessionId } });
  logger.info(`[CAT_RESULT]:\n${catOutput.output}`);

  // 4. Kill the session
  logger.info('Killing session...');
  await handleAction({ action: 'kill', params: { sessionId } });

  logger.info('✅ Terminal-Actuator Demo complete.');
}

runDemo().catch(err => {
  console.error(err);
  process.exit(1);
});
