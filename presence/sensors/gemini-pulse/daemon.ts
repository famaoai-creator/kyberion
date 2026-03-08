/**
 * Gemini Pulse Daemon v3.0 (GUSP v1.0 Edition)
 * Monitors ecosystem health and emits heartbeats and GUSP-compliant stimuli.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { 
  logger, 
  safeWriteFile, 
  pathResolver, 
  safeExistsSync, 
  safeMkdir, 
  safeAppendFileSync 
} from '@agent/core';

const HEARTBEAT_INTERVAL_MS = 60000;
const PULSE_PATH = pathResolver.resolve('presence/bridge/runtime/pulse.json');
const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');

async function pulseLoop() {
  logger.info('💓 Gemini Pulse (GUSP v1.0) active. Monitoring ecosystem health...');

  while (true) {
    const memory = process.memoryUsage();
    const uptime = process.uptime();
    const date = new Date();

    const heartbeat = {
      timestamp: date.toISOString(),
      status: 'ALIVE',
      memory,
      uptime
    };

    try {
      const dir = path.dirname(PULSE_PATH);
      if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
      safeWriteFile(PULSE_PATH, JSON.stringify(heartbeat, null, 2));

      // Example: If memory usage is high, emit a GUSP stimulus (Whisper)
      if (memory.heapUsed > 500 * 1024 * 1024) { // 500MB
        const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
        const shortId = crypto.randomBytes(3).toString('hex');
        
        const stimulus = {
          id: `req-${dateStr}-pulse-${shortId}`,
          ts: date.toISOString(),
          ttl: 300, // Short TTL for pulse alerts
          origin: { channel: 'system', source_id: 'gemini-pulse' },
          signal: {
            intent: 'whisper',
            priority: 3,
            payload: `[SYSTEM_ALERT] High memory usage detected: ${Math.round(memory.heapUsed / 1024 / 1024)}MB. Consider clearing cache.`
          },
          control: {
            status: 'pending',
            feedback: 'silent',
            evidence: [{ step: 'pulse_detection', ts: date.toISOString(), agent: 'gemini-pulse' }]
          }
        };
        safeAppendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
        logger.warn(`🚨 High memory stimulus emitted: ${stimulus.id}`);
      }

    } catch (err: any) {
      logger.error(`Pulse Error: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, HEARTBEAT_INTERVAL_MS));
  }
}

pulseLoop().catch(err => {
  logger.error(`Pulse Daemon crashed: ${err.message}`);
  process.exit(1);
});
