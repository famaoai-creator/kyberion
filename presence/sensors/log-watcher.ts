/**
 * Log Watcher Sensor v1.0 (GUSP v1.0 Edition)
 * Monitores system logs and converts errors into sensory stimuli.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { logger, pathResolver } from '@agent/core';

const LOGS_DIR = pathResolver.active('shared/logs');
const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const CHECK_INTERVAL_MS = 10000;

const logOffsets = new Map<string, number>();

async function scanLogs() {
  if (!fs.existsSync(LOGS_DIR)) return;
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));

  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    const stats = fs.statSync(filePath);
    const lastPos = logOffsets.get(file) || 0;

    if (stats.size > lastPos) {
      const content = fs.readFileSync(filePath, 'utf8').substring(lastPos);
      const lines = content.split('\n');
      
      for (const line of lines) {
        if (line.toUpperCase().includes('ERROR') || line.toUpperCase().includes('FAILED')) {
          emitAlert(file, line.trim());
        }
      }
      logOffsets.set(file, stats.size);
    } else if (stats.size < lastPos) {
      // Log rotation or truncation
      logOffsets.set(file, 0);
    }
  }
}

function emitAlert(sourceFile: string, text: string) {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  const shortId = crypto.randomBytes(3).toString('hex');

  const stimulus = {
    id: `req-${dateStr}-alert-${shortId}`,
    ts: date.toISOString(),
    ttl: 1800,
    origin: { channel: 'system', source_id: `log-watcher:${sourceFile}` },
    signal: {
      intent: 'alert',
      priority: 9,
      payload: `[AUTONOMIC_ALERT] System error detected in ${sourceFile}: ${text}`
    },
    control: {
      status: 'pending',
      feedback: 'auto',
      evidence: [{ step: 'log_detection', ts: date.toISOString(), agent: 'log-watcher' }]
    }
  };

  fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
  logger.error(`🚨 System Alert Emitted from ${sourceFile}: ${stimulus.id}`);
}

async function startWatcher() {
  logger.info('🛡️ Autonomic Log Watcher active. Monitoring system logs...');
  setInterval(scanLogs, CHECK_INTERVAL_MS);
}

startWatcher();
