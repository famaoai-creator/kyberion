/**
 * Kyberion Local Chat — Interactive REPL using Local LLM with Tool Use.
 * 
 * Usage:
 *   KYBERION_REASONING_BACKEND=local pnpm exec ts-node scripts/chat_local.ts
 */

import * as readline from 'node:readline';
import { getReasoningBackend, installReasoningBackends, logger } from '@agent/core';

async function main() {
  logger.info('🚀 Initializing Kyberion Local Chat...');

  const success = installReasoningBackends({ mode: 'local', force: true });
  if (!success) {
    logger.error('Failed to initialize local reasoning backend.');
    process.exit(1);
  }

  const backend = getReasoningBackend();
  logger.success(`Kyberion is online via ${backend.name}.`);
  console.log('\n--- Kyberion Local REPL ---');
  console.log('Type your message to start. Type "exit" or "quit" to stop.');
  console.log('You can ask me to read or write files in this directory.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'CEO> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      rl.close();
      return;
    }

    if (input) {
      try {
        process.stdout.write('Kyberion> ');
        const response = await backend.prompt(input);
        console.log(response);
      } catch (err: any) {
        logger.error(`Error: ${err.message}`);
      }
    }
    rl.prompt();
  }).on('close', () => {
    console.log('\nSession closed. Goodbye.');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
