import * as path from 'node:path';
import { logger } from '@agent/core';
import { pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as superNerve from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';
import type { A2AMessage } from '../libs/actuators/orchestrator-actuator/src/super-nerve/index.js';
import { readJson } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main() {
  const argv = await createStandardYargs()
    .option('input', {
      alias: 'i',
      type: 'string',
      required: true,
      description: 'Path to A2A Message JSON',
    })
    .parseSync();

  const inputPath = String(argv.input);
  const resolvedInput = path.isAbsolute(inputPath)
    ? inputPath
    : pathResolver.rootResolve(inputPath);
  const a2aMsg = readJson<A2AMessage>(resolvedInput);

  if (!a2aMsg.header || !a2aMsg.payload) {
    throw new Error('Invalid A2A Message: Missing header or payload.');
  }

  logger.info(
    `🚀 [A2A_GATEWAY] Receiving A2A message [ID: ${a2aMsg.header.msg_id}] from ${a2aMsg.header.sender}`
  );

  try {
    const result = await superNerve.executeSuperPipeline(a2aMsg);

    // Create A2A response envelope
    const response: A2AMessage = {
      a2a_version: '1.0',
      header: {
        msg_id: `resp-${Date.now()}`,
        parent_id: a2aMsg.header.msg_id,
        conversation_id: a2aMsg.header.conversation_id,
        sender: 'kyberion:nerve',
        receiver: a2aMsg.header.sender,
        performative: 'result',
        timestamp: new Date().toISOString(),
      },
      payload: result,
    };

    console.log(JSON.stringify(response, null, 2));
    logger.success(
      `✅ [A2A_GATEWAY] A2A interaction completed for Conversation: ${a2aMsg.header.conversation_id}`
    );
  } catch (err: any) {
    logger.error(`❌ [A2A_GATEWAY] A2A interaction failed: ${err.message}`);
    throw err;
  }
}

export const runA2A = defineScript({
  name: 'a2a:run',
  flags: [],
  run() {
    return main();
  },
});

if (isDirectScript(import.meta.url, 'run_a2a.ts') || isDirectScript(import.meta.url, 'run_a2a.js'))
  void runA2A();
