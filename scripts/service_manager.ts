/**
 * scripts/service_manager.ts
 * Manages background presence services (Sensors, Daemons) with Auto-Healing.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { logger } from '@agent/core/core';
import { safeReadFile, safeWriteFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';
import { pruneStimuli } from './presence-controller.js';

const PID_FILE = pathResolver.active('shared/services-pids.json');
const WATCHDOG_INTERVAL_MS = 30000;

const SERVICES: Record<string, any> = {
  'slack-sensor': {
    path: 'dist/presence/sensors/slack-sensor.js',
    description: 'Listens for Slack mentions and DMs'
  },
  'reflex-terminal': {
    path: 'dist/scripts/rt-orchestrator.js',
    description: 'Persistent AI-native virtual terminal session'
  },
  'nexus-daemon': {
    path: 'dist/presence/bridge/nexus-daemon.js',
    description: 'Coordinates physical terminal intervention'
  },
  'gemini-pulse': {
    path: 'dist/presence/sensors/gemini-pulse/daemon.js',
    description: 'Monitors ecosystem health'
  },
  'service-watchdog': {
    path: 'dist/scripts/service_manager.js',
    args: ['watchdog'],
    description: 'Auto-heals other services if they crash'
  }
};

function loadPids() {
  if (!fs.existsSync(PID_FILE)) return {};
  try {
    return JSON.parse(safeReadFile(PID_FILE, { encoding: 'utf8' }) as string);
  } catch (_) {
    return {};
  }
}

function savePids(pids: any) {
  safeWriteFile(PID_FILE, JSON.stringify(pids, null, 2));
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function startService(id: string, pids: any) {
  const service = SERVICES[id];
  if (!service) return;

  const scriptPath = pathResolver.rootResolve(service.path);
  const logFile = pathResolver.active(`shared/logs/${id}.log`);
  if (!fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

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
  logger.info(chalk.bold.cyan('🛡️ Service Watchdog Active. Monitoring for crashes & log bloat...'));
  
  while (true) {
    const pids = loadPids();
    let changed = false;

    for (const [id, service] of Object.entries(SERVICES)) {
      if (id === 'service-watchdog') continue;

      const pid = pids[id];
      if (!pid || !isRunning(pid)) {
        logger.warn(`⚠️ Service crash detected: ${id}. Attempting auto-recovery...`);
        await startService(id, pids);
        changed = true;
      }
    }

    if (changed) savePids(pids);

    try {
      await pruneStimuli();
    } catch (_) {}

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
    case 'start':
      await startAll();
      break;
    case 'stop':
      stopAll();
      break;
    case 'status':
      showStatus();
      break;
    case 'watchdog':
      await runWatchdog();
      break;
    default:
      console.log('Usage: node service_manager.js [start|stop|status|watchdog]');
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
