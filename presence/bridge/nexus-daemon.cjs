#!/usr/bin/env node
/**
 * Nexus Daemon v1.0
 * Background stimuli watcher that triggers physical terminal intervention.
 /**
  * Flow: Watch stimuli.jsonl -> Detect PENDING -> Find Idle iTerm2 Session -> Inject Intervention Command.
  */

const { logger, safeReadFile, safeWriteFile, pathResolver, terminalBridge } = require('@agent/core');
const fs = require('fs');

const STIMULI_PATH = pathResolver.rootResolve('presence/bridge/stimuli.jsonl');
const CHECK_INTERVAL_MS = 5000; // Watch every 5 seconds

async function markAsInjected(timestamp) {
  try {
    const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' });
    const lines = content.trim().split('\n').map(line => {
      const s = JSON.parse(line);
      if (s.timestamp === timestamp) {
        s.status = 'INJECTED';
        s.injected_at = new Date().toISOString();
      }
      return JSON.stringify(s);
    });
    safeWriteFile(STIMULI_PATH, lines.join('\n') + '\n');
    return true;
  } catch (err) {
    logger.error(`Failed to mark as injected: ${err.message}`);
    return false;
  }
}

async function nexusLoop() {
  logger.info('🛡️ Nexus Daemon active. Watching for sensory stimuli...');

  while (true) {
    if (fs.existsSync(STIMULI_PATH)) {
      try {
        const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' });
        const pending = content.trim().split('\n')
          .map(line => JSON.parse(line))
          .filter(s => s.status === 'PENDING');

        if (pending.length > 0) {
          const stimulus = pending[0]; // Process oldest first
          logger.info(`📡 Stimulus detected: [${stimulus.source_channel}] ${stimulus.payload.substring(0, 30)}...`);

          const session = terminalBridge.findIdleSession();
          if (session) {
            logger.info(`🚀 Terminal (${session.type}) is IDLE. Injecting physical intervention...`);
            
            // Normalize payload newlines
            const cleanPayload = stimulus.payload.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            
            // Standard Intervention Protocol (Wrapped in non-executable tags for safety)
            const cmd = `\n[SENSORY_INPUT_BEGIN]\nSource: ${stimulus.source_channel}\nTS:     ${stimulus.timestamp}\nPayload: <<<\n${cleanPayload}\n>>>\n[SENSORY_INPUT_END]\n`;
            
            const success = terminalBridge.injectAndExecute(session.winId, session.sessionId, cmd, session.type);
            if (success) {
              await markAsInjected(stimulus.timestamp);
              logger.success(`✅ Intervention command sent and marked as INJECTED. (${session.type})`);
            }
          } else {
            logger.info('⏳ Terminal is busy or not found. Waiting for next heartbeat...');
          }
        }
      } catch (err) {
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
