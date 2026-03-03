/**
 * Nexus Daemon v2.0 (Type-Safe TS Edition)
 * Background stimuli watcher that triggers physical terminal intervention.
 */

import { logger, safeReadFile, safeWriteFile, pathResolver, terminalBridge } from '@agent/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/stimuli.jsonl');
const CHECK_INTERVAL_MS = 5000;

interface Stimulus {
  timestamp: string;
  source_channel: string;
  payload: string;
  status: 'PENDING' | 'INJECTED' | 'PROCESSED';
  [key: string]: any;
}

async function markAsInjected(timestamp: string): Promise<boolean> {
  try {
    const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
    const lines = content.trim().split('\n').map(line => {
      const s = JSON.parse(line) as Stimulus;
      if (s.timestamp === timestamp) {
        s.status = 'INJECTED';
        s.injected_at = new Date().toISOString();
      }
      return JSON.stringify(s);
    });
    safeWriteFile(STIMULI_PATH, lines.join('\n') + '\n');
    return true;
  } catch (err: any) {
    logger.error(`Failed to mark as injected: ${err.message}`);
    return false;
  }
}

async function nexusLoop() {
  logger.info('🛡️ Nexus Daemon (TS) active. Watching for sensory stimuli...');

  while (true) {
    if (fs.existsSync(STIMULI_PATH)) {
      try {
        const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
        const pending = content.trim().split('\n')
          .filter(l => l.length > 0)
          .map(line => JSON.parse(line) as Stimulus)
          .filter(s => s.status === 'PENDING');

        if (pending.length > 0) {
          const stimulus = pending[0];
          logger.info(`📡 Stimulus detected: [${stimulus.source_channel}] ${stimulus.payload.substring(0, 30)}...`);

          const session = terminalBridge.findIdleSession();
          if (session) {
            logger.info(`🚀 Terminal (${session.type}) is IDLE. Injecting...`);
            
            const cleanPayload = stimulus.payload.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
            const cmd = `\n[SENSORY_INPUT_BEGIN]\nSource: ${stimulus.source_channel}\nPayload: <<<\n${cleanPayload}\n>>>\n[SENSORY_INPUT_END]\n`;
            
            const success = terminalBridge.injectAndExecute(session.winId, session.sessionId, cmd, session.type);
            if (success) {
              await markAsInjected(stimulus.timestamp);
              logger.success(`✅ Injected to ${session.type}`);
            }
          }
        }
      } catch (err: any) {
        logger.error(`Loop Error: ${err.message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

nexusLoop().catch(err => {
  logger.error(`Nexus Daemon crashed: ${err.message}`);
  process.exit(1);
});
