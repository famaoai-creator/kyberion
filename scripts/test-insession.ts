import { getReasoningBackend } from '@agent/core/reasoning-backend';
import { installReasoningBackends } from '@agent/core/reasoning-bootstrap';
import { logger } from '@agent/core/core';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

async function test(print: Print = () => undefined) {
  logger.info('--- Initializing Native Gemini CLI Backend ---');
  // Install the reasoning backend forcing gemini-cli mode
  const installed = installReasoningBackends({ mode: 'gemini-cli' });

  if (!installed) {
    logger.error('Failed to install gemini-cli backend');
    throw new Error('Failed to install gemini-cli backend');
  }

  const backend = getReasoningBackend();

  logger.info('--- Delegating Task via Native invoke_agent ---');
  try {
    const result = await backend.delegateTask(
      '「こんにちは」と返事をしてください。他の言葉は不要です。'
    );
    logger.info('\n--- Sub-agent Result ---');
    print(result);
  } catch (err: unknown) {
    const error = err as { message?: string };
    logger.error(`Error during delegation: ${error.message || String(err)}`);
  }
}

export const runInSessionTest = defineScript({
  name: 'test-insession',
  flags: [],
  run({ print }) {
    return test(print);
  },
});

if (
  isDirectScript(import.meta.url, 'test-insession.ts') ||
  isDirectScript(import.meta.url, 'test-insession.js')
)
  void runInSessionTest();
