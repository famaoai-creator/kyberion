/**
 * Reflex Terminal Orchestrator v1.0
 * Entry point for the AI-native persistent terminal session.
 */

import { ReflexTerminal, logger, pathResolver } from '@agent/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  logger.info('🚀 Initializing Gemini Reflex Terminal (RT)...');

  // Neural Bridge Hook: 
  // Decides when to mirror terminal output back to Slack automatically.
  let outputAccumulator = '';
  let lastActivity = Date.now();

  const rt = new ReflexTerminal({
    shell: process.env.SHELL || 'zsh',
    cwd: process.cwd(),
    feedbackPath: pathResolver.resolve('active/shared/last_response.json'),
    onOutput: (data) => {
      outputAccumulator += data;
      lastActivity = Date.now();
    }
  });

  // Simple heuristic: If terminal is quiet for 2 seconds and has new output, mirror it.
  setInterval(() => {
    const now = Date.now();
    if (outputAccumulator.length > 0 && (now - lastActivity > 2000)) {
      logger.info(`[RT] Auto-mirroring quiet period detected (${outputAccumulator.length} chars)`);
      rt.persistResponse(outputAccumulator, 'reflex-terminal-auto');
      outputAccumulator = '';
    }
  }, 1000);

  // Note: We don't pipe STDIN here because this is meant to be a 
  // background 'shadow' terminal controlled primarily via Slack/Stimuli.
  
  logger.success('✅ Reflex Terminal is now ACTIVE and watching for stimuli.');
  
  // Keep alive
  process.stdin.resume();
}

main().catch(err => {
  logger.error(`RT Orchestrator Failed: ${err.message}`);
  process.exit(1);
});
