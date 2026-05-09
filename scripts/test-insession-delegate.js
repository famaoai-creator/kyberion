import { buildGeminiCliBackendFromEnv } from '../dist/libs/core/src/gemini-cli-backend.js';

async function test() {
  console.log('--- Initializing Native Gemini CLI Backend ---');
  // We force model to match current session if possible, or omit to use default
  const backend = buildGeminiCliBackendFromEnv(process.env);
  if (!backend) {
    console.error('Failed to initialize gemini-cli backend');
    process.exit(1);
  }

  console.log('--- Delegating Task via Native invoke_agent ---');
  try {
    const result = await backend.delegateTask('「こんにちは」と返事をしてください。他の言葉は不要です。');
    console.log('\n--- Sub-agent Result ---');
    console.log(result);
  } catch (err) {
    console.error('Error during delegation:', err);
  }
}

test();
