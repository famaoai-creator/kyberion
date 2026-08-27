import { installReasoningBackends, getReasoningBackend, logger } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

async function test() {
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
    console.log(result);
  } catch (err: unknown) {
    const error = err as { message?: string };
    logger.error(`Error during delegation: ${error.message || String(err)}`);
  }
}

export const runInSessionTest = defineScript({
  name: 'test-insession',
  flags: [],
  run() {
    return test();
  },
});

if (
  isDirectScript(import.meta.url, 'test-insession.ts') ||
  isDirectScript(import.meta.url, 'test-insession.js')
)
  void runInSessionTest();
