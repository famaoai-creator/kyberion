/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { sendOpsAlert } from '@agent/core/ops-alert';
import { spawn } from 'node:child_process';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

const DEFAULT_INTERVAL_MS = Number(
  getRegisteredEnvText('KYBERION_GENERATION_SCHEDULE_INTERVAL_MS') || 60_000
);
const ROOT_DIR = pathResolver.rootDir();
const SCHEDULE_TICK_ENTRY = pathResolver.rootResolve('dist/scripts/run_generation_schedule.js');
const DAEMON_ID = 'generation-schedule-daemon';

/**
 * EV-05: this loop previously recorded no heartbeat, so `daemon_watchdog` could
 * not observe it and an outage produced no signal at all. A tick failure now
 * also stops killing the daemon: the loop reports and continues, because
 * exiting on one bad tick was itself an unobserved outage.
 */
async function runTick(): Promise<void> {
  const child = spawn(process.execPath, [SCHEDULE_TICK_ENTRY, '--action', 'tick'], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: 'inherit',
  });

  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`generation schedule daemon tick failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main(_args: string[] = []) {
  recordDaemonHeartbeat(DAEMON_ID, {
    status: 'starting',
    details: { tick_interval_ms: DEFAULT_INTERVAL_MS },
  });

  while (true) {
    recordDaemonHeartbeat(DAEMON_ID, { status: 'running', details: { phase: 'tick' } });
    try {
      await runTick();
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(`[generation-schedule-daemon] tick error: ${message}`);
      recordDaemonHeartbeat(DAEMON_ID, { status: 'error', details: { error: message } });
      sendOpsAlert({
        severity: 'warning',
        title: 'Generation schedule tick failed',
        context: { daemon_id: DAEMON_ID, error: message },
        recommendation:
          'Inspect the media-generation schedule registry and the last generation job; the daemon keeps ticking.',
        dedupe_key: `${DAEMON_ID}:tick-failed`,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, DEFAULT_INTERVAL_MS));
  }
}

const runGenerationScheduleDaemon = defineScript({
  name: 'generation:schedule-daemon',
  flags: [],
  run: async ({ argv }) => {
    try {
      await main(argv);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      logger.error(message);
      recordDaemonHeartbeat(DAEMON_ID, { status: 'error', details: { error: message } });
      sendOpsAlert({
        severity: 'critical',
        title: 'Generation schedule daemon fatal error',
        context: { daemon_id: DAEMON_ID, error: message },
        recommendation: 'Restart the generation schedule daemon unit and inspect its logs.',
        dedupe_key: `${DAEMON_ID}:fatal`,
      });
      process.exitCode = 1;
    }
  },
});

if (
  isDirectScript(import.meta.url, 'run_generation_schedule_daemon.ts') ||
  isDirectScript(import.meta.url, 'run_generation_schedule_daemon.js')
) {
  void runGenerationScheduleDaemon();
}
