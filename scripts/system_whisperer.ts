/**
 * scripts/system_whisperer.ts
 * Advanced System Whisperer v1.1.
 * Periodic environment awareness for the AI agent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { logger, pathResolver } from '@agent/core';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const PID_FILE = pathResolver.shared('services-pids.json');
const WHISPER_INTERVAL_MS = 1800000; // 30 minutes

async function whisper() {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const date = new Date();
  
  // 1. Service Health Check
  let serviceStatus = "All services operational.";
  if (fs.existsSync(PID_FILE)) {
    try {
      const pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
      const activeCount = Object.keys(pids).length;
      serviceStatus = `${activeCount} services registered in PID registry.`;
    } catch (e) {}
  }

  // 2. Pending Tasks
  let pendingCount = 0;
  if (fs.existsSync(STIMULI_PATH)) {
    try {
      const raw = fs.readFileSync(STIMULI_PATH, 'utf8').trim().split('\n');
      pendingCount = raw.filter(l => l.includes('"status":"pending"')).length;
    } catch (e) {}
  }

  const payload = `[SYSTEM_WHISPER] Operational Intelligence:
- Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB used
- Uptime: ${Math.round(uptime / 3600)}h ${Math.round((uptime % 3600) / 60)}m
- Services: ${serviceStatus}
- Queue: ${pendingCount} stimuli pending
- Platform: ${process.platform} (${osRelease()})
Agent resonance is stable.`;

  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  const shortId = crypto.randomBytes(3).toString('hex');

  const stimulus = {
    id: `req-${dateStr}-whisper-${shortId}`,
    ts: date.toISOString(),
    ttl: 3600,
    origin: { channel: 'system', source_id: 'system-whisperer' },
    signal: { intent: 'whisper', priority: 2, payload },
    control: {
      status: 'pending', feedback: 'silent',
      evidence: [{ step: 'whisper_generation', ts: date.toISOString(), agent: 'system-whisperer' }]
    }
  };

  fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
  logger.info(`🌬️ System Whisper emitted: ${stimulus.id}`);
}

function osRelease() {
  try {
    const { execSync } = require('node:child_process');
    return execSync('uname -sr', { encoding: 'utf8' }).trim();
  } catch (e) { return 'unknown'; }
}

async function startWhispering() {
  logger.info('🌬️ System Whisperer active.');
  await whisper();
  setInterval(whisper, WHISPER_INTERVAL_MS);
}

startWhispering();
