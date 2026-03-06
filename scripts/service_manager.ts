/**
 * scripts/service_manager.ts
 * Manages background presence services (Sensors, Daemons) with Auto-Healing.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import chalk from 'chalk';
import { logger } from '@agent/core/core';

const rootDir = process.cwd();
const PID_FILE = path.join(rootDir, 'active/shared/services-pids.json');
const STIMULI_PATH = path.join(rootDir, 'presence/bridge/runtime/stimuli.jsonl');
const WATCHDOG_INTERVAL_MS = 30000;

const SERVICES: Record<string, any> = {
  'slack-sensor': {
    path: 'presence/sensors/slack-sensor.ts',
    description: 'Listens for Slack mentions and DMs'
  },
  /* 
   * NOTE: 'terminal-hub' (presence/bridge/terminal/server.ts) is EXCLUDED from automatic background startup.
   * On macOS, node-pty requires a real TTY to avoid 'posix_spawnp failed'.
   * Please run it manually in a dedicated foreground terminal tab:
   * $ npx tsx presence/bridge/terminal/server.ts
   */
  'nexus-daemon': {
    path: 'presence/bridge/nexus-daemon.ts',
    description: 'Coordinates physical terminal intervention'
  },
  'log-watcher': {
    path: 'presence/sensors/log-watcher.ts',
    description: 'Monitors logs for system errors'
  },
  'visual-buffer': {
    path: 'presence/sensors/visual-buffer-daemon.ts',
    description: 'Maintains rolling visual frames for temporal awareness'
  },
  'system-whisperer': {
    path: 'scripts/system_whisperer.ts',
    description: 'Injects periodic system status to the agent'
  }
};

function loadPids() {
  if (!fs.existsSync(PID_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function savePids(pids: any) {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function emitRecoveryStimulus(serviceId: string) {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
  const shortId = crypto.randomBytes(3).toString('hex');

  const stimulus = {
    id: `req-${dateStr}-recovery-${shortId}`,
    ts: date.toISOString(),
    ttl: 600,
    origin: { channel: 'system', source_id: 'service-watchdog' },
    signal: {
      intent: 'alert',
      priority: 8,
      payload: `[SELF_HEALING] Service '${serviceId}' crash detected and recovered.`
    },
    control: {
      status: 'pending',
      feedback: 'auto',
      evidence: [{ step: 'auto_recovery', ts: date.toISOString(), agent: 'service-watchdog' }]
    }
  };

  fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + "\n");
}

async function startService(id: string, pids: any) {
  const service = SERVICES[id];
  if (!service) return;

  const scriptPath = path.join(rootDir, service.path);
  const logFile = path.join(rootDir, `active/shared/logs/${id}.log`);
  if (!fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  const out = fs.openSync(logFile, 'a');
  const child = spawn('npx', ['tsx', scriptPath], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: rootDir,
    env: { ...process.env, PORT: '4321' }
  });

  child.unref();
  pids[id] = child.pid;
  logger.success(`  - ${id} started (PID: ${child.pid}). Logs: active/shared/logs/${id}.log`);
}

async function startAll() {
  const pids = loadPids();
  logger.info('🚀 Starting Presence Services...');
  for (const id of Object.keys(SERVICES)) {
    if (pids[id] && isRunning(pids[id])) {
      logger.info(`  - ${id} is already running (PID: ${pids[id]})`);
      continue;
    }
    await startService(id, pids);
  }
  savePids(pids);
}

function stopAll() {
  const pids = loadPids();
  logger.info('🛑 Stopping Presence Services...');
  for (const [id, pid] of Object.entries(pids)) {
    if (isRunning(pid as number)) {
      try {
        process.kill(pid as number, 'SIGTERM');
        logger.success(`  - ${id} (PID: ${pid}) stopped.`);
      } catch (err: any) {
        logger.error(`  - Failed to stop ${id}: ${err.message}`);
      }
    }
    delete pids[id];
  }
  savePids(pids);
}

async function runWatchdog() {
  logger.info(chalk.bold.cyan('🛡️ Service Watchdog Active. Monitoring for crashes...'));
  while (true) {
    const pids = loadPids();
    let changed = false;
    for (const [id, service] of Object.entries(SERVICES)) {
      const pid = pids[id];
      if (!pid || !isRunning(pid)) {
        logger.warn(`⚠️ Service crash detected: ${id}. Attempting auto-recovery...`);
        await startService(id, pids);
        emitRecoveryStimulus(id);
        changed = true;
      }
    }
    if (changed) savePids(pids);
    await new Promise(resolve => setTimeout(resolve, WATCHDOG_INTERVAL_MS));
  }
}

function showStatus() {
  const pids = loadPids();
  console.log(chalk.bold('\n📡 Presence Services Status:'));
  console.log('━'.repeat(40));
  for (const [id, service] of Object.entries(SERVICES)) {
    const pid = pids[id];
    const active = pid && isRunning(pid);
    const statusStr = active ? chalk.green('RUNNING') : chalk.red('STOPPED');
    const pidStr = active ? `(PID: ${pid})` : '';
    console.log(`  ${id.padEnd(16)} : ${statusStr} ${pidStr}`);
    console.log(`    ${chalk.dim(service.description)}`);
  }
  console.log('');
}

async function main() {
  const action = process.argv[2] || 'status';
  switch (action) {
    case 'start': await startAll(); break;
    case 'stop': stopAll(); break;
    case 'status': showStatus(); break;
    case 'watchdog': await runWatchdog(); break;
    default:
      console.log('Usage: npx tsx scripts/service_manager.ts [start|stop|status|watchdog]');
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
