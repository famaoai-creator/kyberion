/**
 * Gemini Pulse Daemon v2.0 (Type-Safe TS Edition)
 * Monitors ecosystem health and emits heartbeat signals.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeWriteFile, pathResolver } from '@agent/core';

const HEARTBEAT_INTERVAL_MS = 60000; // 1 minute
const PULSE_PATH = pathResolver.active('shared/pulse.json');

async function pulseLoop() {
  logger.info('💓 Gemini Pulse (TS) active. Monitoring ecosystem health...');

  while (true) {
    const heartbeat = {
      timestamp: new Date().toISOString(),
      status: 'ALIVE',
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };

    try {
      const dir = path.dirname(PULSE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      safeWriteFile(PULSE_PATH, JSON.stringify(heartbeat, null, 2));
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
