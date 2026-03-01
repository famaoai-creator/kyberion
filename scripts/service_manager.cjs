#!/usr/bin/env node
/**
 * System Service Manager v1.1 (Watchdog Edition)
 * Manages background presence services (Sensors, Daemons) with Auto-Healing.
 */

const { logger, pathResolver, safeWriteFile, safeReadFile, chalk } = require('./system-prelude.cjs');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PID_FILE = pathResolver.active('shared/services-pids.json');
const WATCHDOG_INTERVAL_MS = 30000; // 30 seconds

const SERVICES = {
  'slack-sensor': {
    path: 'presence/sensors/slack-sensor.cjs',
    description: 'Listens for Slack mentions and DMs'
  },
  'nexus-daemon': {
    path: 'presence/bridge/nexus-daemon.cjs',
    description: 'Coordinates physical terminal intervention'
  },
  'gemini-pulse': {
    path: 'presence/sensors/gemini-pulse/daemon.cjs',
    description: 'Monitors ecosystem health'
  },
  'service-watchdog': {
    path: 'scripts/service_manager.cjs',
    args: ['watchdog'],
    description: 'Auto-heals other services if they crash'
  }
};

function loadPids() {
  if (!fs.existsSync(PID_FILE)) return {};
  try {
    return JSON.parse(safeReadFile(PID_FILE, { encoding: 'utf8' }));
  } catch (_) {
    return {};
  }
}

function savePids(pids) {
  safeWriteFile(PID_FILE, JSON.stringify(pids, null, 2));
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function startService(id, pids) {
  const service = SERVICES[id];
  if (!service) return;

  const scriptPath = pathResolver.rootResolve(service.path);
  const logFile = pathResolver.active(`shared/logs/${id}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const out = fs.openSync(logFile, 'a');
  const child = spawn('node', [scriptPath, ...(service.args || [])], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: pathResolver.rootDir()
  });

  child.unref();
  pids[id] = child.pid;
  logger.success(`  - ${id} started (PID: ${child.pid}). Logs: ${path.basename(logFile)}`);
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
    if (isRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        logger.success(`  - ${id} (PID: ${pid}) stopped.`);
      } catch (err) {
        logger.error(`  - Failed to stop ${id}: ${err.message}`);
      }
    }
    delete pids[id];
  }

  savePids(pids);
}

/**
 * Watchdog Mode: Periodically checks and restarts crashed services.
 */
async function runWatchdog() {
  logger.info(chalk.bold.cyan('🛡️ Service Watchdog Active. Monitoring for crashes...'));
  
  while (true) {
    const pids = loadPids();
    let changed = false;

    for (const [id, service] of Object.entries(SERVICES)) {
      // Don't monitor yourself to avoid loop-recursion (it's managed by the OS/Process List)
      if (id === 'service-watchdog') continue;

      const pid = pids[id];
      if (!pid || !isRunning(pid)) {
        logger.warn(`⚠️ Service crash detected: ${id}. Attempting auto-recovery...`);
        await startService(id, pids);
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

const action = process.argv[2] || 'status';

switch (action) {
  case 'start':
    startAll();
    break;
  case 'stop':
    stopAll();
    break;
  case 'status':
    showStatus();
    break;
  case 'watchdog':
    runWatchdog();
    break;
  default:
    logger.error('Usage: node service_manager.cjs [start|stop|status|watchdog]');
}
