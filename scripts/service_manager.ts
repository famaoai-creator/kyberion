/**
 * scripts/service_manager.ts
 * Manages background presence services (Sensors, Daemons) with Auto-Healing.
 * [SECURE-IO COMPLIANT VERSION]
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import chalk from 'chalk';
import { logger, safeWriteFile, safeReadFile, safeAppendFile } from '@agent/core';

const rootDir = process.cwd();
const PID_FILE = path.join(rootDir, 'active/shared/services-pids.json');
const STIMULI_PATH = path.join(rootDir, 'presence/bridge/runtime/stimuli.jsonl');
const WATCHDOG_INTERVAL_MS = 30000;

const SERVICES: Record<string, any> = {
  'slack-sensor': { path: 'presence/sensors/slack-sensor.ts', description: 'Listens for Slack mentions and DMs' },
  'nexus-daemon': { path: 'presence/bridge/nexus-daemon.ts', description: 'Coordinates physical terminal intervention' },
  'log-watcher': { path: 'presence/sensors/log-watcher.ts', description: 'Monitors logs for system errors' },
  'visual-buffer': { path: 'presence/sensors/visual-buffer-daemon.ts', description: 'Maintains rolling visual frames' },
  'system-whisperer': { path: 'scripts/system_whisperer.ts', description: 'Injects periodic system status' }
};

function loadPids() {
  if (!fs.existsSync(PID_FILE)) return {};
  try {
    const content = safeReadFile(PID_FILE, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return {}; }
}

function savePids(pids: any) {
  safeWriteFile(PID_FILE, JSON.stringify(pids, null, 2));
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) { return false; }
}

function emitRecoveryStimulus(serviceId: string) {
  const date = new Date();
  const stimulus = {
    id: `req-${date.toISOString().split('T')[0].replace(/-/g, '')}-recovery-${crypto.randomBytes(3).toString('hex')}`,
    ts: date.toISOString(),
    ttl: 600,
    origin: { channel: 'system', source_id: 'service-watchdog' },
    signal: { intent: 'alert', priority: 8, payload: `[SELF_HEALING] Service '${serviceId}' crash detected.` },
    control: { status: 'pending', feedback: 'auto', evidence: [{ step: 'auto_recovery', ts: date.toISOString(), agent: 'service-watchdog' }] }
  };
  safeAppendFile(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
}

async function startService(id: string, pids: any) {
  const service = SERVICES[id];
  if (!service) return;
  const scriptPath = path.join(rootDir, service.path);
  const logFile = path.join(rootDir, `active/shared/logs/${id}.log`);
  if (!fs.existsSync(path.dirname(logFile))) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn('npx', ['tsx', scriptPath], { detached: true, stdio: ['ignore', out, out], cwd: rootDir, env: { ...process.env, PORT: '4321' } });
  child.unref();
  pids[id] = child.pid;
  logger.success(`  - ${id} started (PID: ${child.pid}).`);
}

async function startAll() {
  const pids = loadPids();
  logger.info('🚀 Starting Presence Services...');
  for (const id of Object.keys(SERVICES)) {
    if (pids[id] && isRunning(pids[id])) continue;
    await startService(id, pids);
  }
  savePids(pids);
}

function stopAll() {
  const pids = loadPids();
  logger.info('🛑 Stopping Presence Services...');
  for (const [id, pid] of Object.entries(pids)) {
    if (isRunning(pid as number)) {
      try { process.kill(pid as number, 'SIGTERM'); } catch (_) {}
    }
    delete pids[id];
  }
  savePids(pids);
}

async function main() {
  const action = process.argv[2] || 'status';
  switch (action) {
    case 'start': await startAll(); break;
    case 'stop': stopAll(); break;
    case 'watchdog': 
      logger.info(chalk.bold.cyan('🛡️ Watchdog Active...'));
      while (true) {
        const pids = loadPids();
        let changed = false;
        for (const id of Object.keys(SERVICES)) {
          if (!pids[id] || !isRunning(pids[id])) {
            await startService(id, pids);
            emitRecoveryStimulus(id);
            changed = true;
          }
        }
        if (changed) savePids(pids);
        await new Promise(r => setTimeout(r, WATCHDOG_INTERVAL_MS));
      }
      break;
    default: console.log('Usage: npx tsx scripts/service_manager.ts [start|stop|watchdog]');
  }
}

main().catch(err => { logger.error(err.message); process.exit(1); });
