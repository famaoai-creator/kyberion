/**
 * Kyberion Local Chat — Interactive REPL using Local LLM with Tool Use.
 *
 * Usage:
 *   KYBERION_REASONING_BACKEND=local pnpm exec ts-node scripts/chat_local.ts
 */

import * as readline from 'node:readline';
import { getReasoningBackend } from '@agent/core/reasoning-backend';
import { installReasoningBackends } from '@agent/core/reasoning-bootstrap';
import { logger } from '@agent/core/core';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main(_args: string[] = []) {
  logger.info('🚀 Initializing Kyberion Local Chat...');

  const success = installReasoningBackends({ mode: 'local', force: true });
  if (!success) {
    logger.error('Failed to initialize local reasoning backend.');
    process.exitCode = 1;
    return;
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
    process.exitCode = 0;
  });
}

const runLocalChat = defineScript({
  name: 'chat:local',
  flags: [],
  run: async ({ argv }) => {
    try {
      await main(argv);
    } catch (err: any) {
      logger.error(err.message);
      process.exitCode = 1;
    }
  },
});

if (
  isDirectScript(import.meta.url, 'chat_local.ts') ||
  isDirectScript(import.meta.url, 'chat_local.js')
) {
  void runLocalChat();
}
