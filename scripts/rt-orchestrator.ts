/**
 * Reflex Terminal Orchestrator v1.1
 * Entry point for the AI-native persistent terminal session.
 * Now with Stimuli Inbox monitoring.
 */

import { ReflexTerminal } from '../libs/core/reflex-terminal.js';
import { logger } from '../libs/core/core.js';
import * as pathResolver from '../libs/core/path-resolver.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const INBOX_PATH = pathResolver.resolve('active/shared/rt_inbox.jsonl');

async function main() {
  logger.info('🚀 Initializing Gemini Reflex Terminal (RT)...');

  const shellPath = '/bin/zsh'; // Explicit absolute path for stability on macOS
  
  // Neural Bridge Hook: 
  // Decides when to mirror terminal output back to Slack automatically.
  let outputAccumulator = '';
  let lastActivity = Date.now();

  const rt = new ReflexTerminal({
    shell: shellPath,
    cwd: process.cwd(),
    feedbackPath: pathResolver.resolve('active/shared/last_response.json'),
    onOutput: (data) => {
      outputAccumulator += data;
      lastActivity = Date.now();
    }
  });

  // 1. Output Monitor (Quiet Period Detection)
  setInterval(() => {
    const now = Date.now();
    if (outputAccumulator.length > 0 && (now - lastActivity > 2500)) {
      logger.info(`[RT] Auto-mirroring quiet period detected (${outputAccumulator.length} chars)`);
      rt.persistResponse(outputAccumulator, 'reflex-terminal-auto');
      outputAccumulator = '';
    }
  }, 1000);

  // 2. Stimuli Inbox Monitor (Input Bridge)
  if (fs.existsSync(INBOX_PATH)) fs.truncateSync(INBOX_PATH); // Clear old stimuli on start

  setInterval(() => {
    if (fs.existsSync(INBOX_PATH)) {
      const stats = fs.statSync(INBOX_PATH);
      if (stats.size > 0) {
        try {
          const content = fs.readFileSync(INBOX_PATH, 'utf8');
          fs.truncateSync(INBOX_PATH); // Mark as read

          const lines = content.trim().split('\n');
          for (const line of lines) {
            if (!line) continue;
            const stimulus = JSON.parse(line);
            logger.info(`📡 [RT] Inbox stimulus detected: ${stimulus.text.substring(0, 30)}...`);
            rt.execute(stimulus.text);
          }
        } catch (err: any) {
          logger.error(`[RT] Inbox process error: ${err.message}`);
        }
      }
    }
  }, 2000);

  logger.success('✅ Reflex Terminal is now ACTIVE and watching for stimuli.');
  
  // Keep alive
  process.stdin.resume();
}

main().catch(err => {
  logger.error(`RT Orchestrator Failed: ${err.message}`);
  process.exit(1);
});
