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
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Print = (value: unknown) => void;

export async function main(_args: string[] = [], print: Print = () => undefined) {
  logger.info('🚀 Initializing Kyberion Local Chat...');

  const success = installReasoningBackends({ mode: 'local', force: true });
  if (!success) {
    throw new ScriptExitError(1, 'Failed to initialize local reasoning backend.');
  }

  const backend = getReasoningBackend();
  logger.success(`Kyberion is online via ${backend.name}.`);
  print('\n--- Kyberion Local REPL ---');
  print('Type your message to start. Type "exit" or "quit" to stop.');
  print('You can ask me to read or write files in this directory.\n');

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
        const response = await backend.prompt(input);
        print(`Kyberion> ${response}`);
      } catch (err: any) {
        logger.error(`Error: ${err.message}`);
      }
    }
    rl.prompt();
  }).on('close', () => {
    print('\nSession closed. Goodbye.');
  });
}

const runLocalChat = defineScript({
  name: 'chat:local',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'chat_local.ts') ||
  isDirectScript(import.meta.url, 'chat_local.js')
) {
  void runLocalChat();
}
