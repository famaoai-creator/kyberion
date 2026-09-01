import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { spawnManagedProcess } from '@agent/core/managed-process';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';
import { appendJsonLine } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

export interface RestartE2EReport {
  timestamp: string;
  root: string;
  bootstrap: {
    pid: number;
    heartbeat_path: string;
    journal_path: string;
  };
  resume: {
    pid: number;
    state_path: string;
  };
  restored: boolean;
}

const DEFAULT_ROOT = pathResolver.sharedTmp('soak-endurance/restart-e2e');

function safeSoakRoot(root: string): string {
  return assertSafeRepositoryPath(root, { allowMissingLeaf: true });
}

function safeSoakPath(root: string, name: string): string {
  return assertSafeRepositoryPath(path.join(safeSoakRoot(root), name), {
    allowMissingLeaf: true,
  });
}

function writeBootstrapState(root: string): RestartE2EReport['bootstrap'] {
  const heartbeatPath = safeSoakPath(root, 'daemon-heartbeat.json');
  const journalPath = safeSoakPath(root, 'mission-journal.json');
  const statePath = safeSoakPath(root, 'provider-health.json');
  safeWriteFile(
    heartbeatPath,
    JSON.stringify(
      { pid: process.pid, phase: 'bootstrap', alive: true, ts: new Date().toISOString() },
      null,
      2
    )
  );
  safeWriteFile(
    journalPath,
    JSON.stringify({ phase: 'bootstrap', entries: ['boot'], complete: false }, null, 2)
  );
  safeWriteFile(
    statePath,
    JSON.stringify({ healthy: true, resumed: false, phase: 'bootstrap' }, null, 2)
  );
  return {
    pid: process.pid,
    heartbeat_path: heartbeatPath,
    journal_path: journalPath,
  };
}

function writeResumeState(root: string): RestartE2EReport['resume'] & { restored: boolean } {
  const heartbeatPath = safeSoakPath(root, 'daemon-heartbeat.json');
  const journalPath = safeSoakPath(root, 'mission-journal.json');
  const statePath = safeSoakPath(root, 'provider-health.json');
  const existing = safeExistsSync(statePath)
    ? readJson<{ phase?: string; resumed?: boolean; restored_from?: string }>(statePath)
    : {};
  safeWriteFile(
    heartbeatPath,
    JSON.stringify(
      { pid: process.pid, phase: 'resume', alive: true, ts: new Date().toISOString() },
      null,
      2
    )
  );
  safeWriteFile(
    journalPath,
    JSON.stringify(
      {
        phase: 'resume',
        entries: ['boot', 'shutdown', 'resume'],
        complete: true,
        resumed_from: existing?.phase || null,
      },
      null,
      2
    )
  );
  safeWriteFile(
    statePath,
    JSON.stringify(
      { healthy: true, resumed: true, phase: 'resume', restored_from: existing?.phase || null },
      null,
      2
    )
  );
  return {
    pid: process.pid,
    state_path: statePath,
    restored: Boolean(existing?.phase),
  };
}

async function runWorker(root: string, phase: 'bootstrap' | 'resume'): Promise<void> {
  const safeRoot = safeSoakRoot(root);
  safeMkdir(safeRoot, { recursive: true });

  if (phase === 'bootstrap') {
    const bootstrapState = writeBootstrapState(safeRoot);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const shutdown = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      safeWriteFile(
        bootstrapState.journal_path,
        JSON.stringify(
          { phase: 'bootstrap', entries: ['boot', 'shutdown'], complete: true },
          null,
          2
        )
      );
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    heartbeatTimer = setInterval(() => {
      appendJsonLine(bootstrapState.heartbeat_path, {
        pid: process.pid,
        phase,
        alive: true,
        ts: new Date().toISOString(),
      });
    }, 100).unref?.();
    await new Promise<void>(() => {});
    return;
  }

  writeResumeState(safeRoot);
}

function spawnWorker(root: string, phase: 'bootstrap' | 'resume') {
  const safeRoot = safeSoakRoot(root);
  return spawnManagedProcess({
    resourceId: `soak-restart-e2e:${phase}:${safeRoot}`,
    kind: 'service',
    ownerId: 'soak_restart_e2e',
    ownerType: 'script',
    command: process.execPath,
    args: [
      '--import',
      './scripts/ts-loader.mjs',
      'scripts/soak_restart_e2e.ts',
      '--worker',
      phase,
      '--root',
      safeRoot,
    ],
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      stdio: 'ignore',
    },
  }).child;
}

function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (safeExistsSync(safeFilePath)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${safeFilePath}`));
      }
    }, 50);
    timer.unref?.();
  });
}

export async function runSoakRestartE2E(root = DEFAULT_ROOT): Promise<RestartE2EReport> {
  const safeRoot = safeSoakRoot(root);
  safeRmSync(safeRoot, { recursive: true, force: true });
  safeMkdir(safeRoot, { recursive: true });

  if (process.env.VITEST === '1' || process.env.NODE_ENV === 'test') {
    const bootstrap = writeBootstrapState(safeRoot);
    safeWriteFile(
      bootstrap.journal_path,
      JSON.stringify({ phase: 'bootstrap', entries: ['boot', 'shutdown'], complete: true }, null, 2)
    );
    const resume = writeResumeState(safeRoot);
    return {
      timestamp: new Date().toISOString(),
      root: safeRoot,
      bootstrap,
      resume: {
        pid: resume.pid,
        state_path: resume.state_path,
      },
      restored: resume.restored,
    };
  }

  const bootstrap = spawnWorker(safeRoot, 'bootstrap');
  const heartbeatPath = safeSoakPath(safeRoot, 'daemon-heartbeat.json');
  const journalPath = safeSoakPath(safeRoot, 'mission-journal.json');
  const statePath = safeSoakPath(safeRoot, 'provider-health.json');
  const bootstrapExit = new Promise<void>((resolve, reject) => {
    bootstrap.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`bootstrap exited ${code}`))
    );
    bootstrap.once('error', reject);
  });
  await waitForFile(heartbeatPath);
  await waitForFile(journalPath);
  bootstrap.kill('SIGTERM');
  await bootstrapExit;

  const resume = spawnWorker(safeRoot, 'resume');
  const resumeExit = new Promise<void>((resolve, reject) => {
    resume.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`resume exited ${code}`))
    );
    resume.once('error', reject);
  });
  await resumeExit;

  if (!safeLstat(statePath).isFile()) {
    throw new Error(`Soak restart state must be a regular file: ${statePath}`);
  }
  const restored = readJson<{ resumed?: boolean; restored_from?: string }>(statePath);
  return {
    timestamp: new Date().toISOString(),
    root: safeRoot,
    bootstrap: {
      pid: bootstrap.pid || 0,
      heartbeat_path: heartbeatPath,
      journal_path: journalPath,
    },
    resume: {
      pid: resume.pid || 0,
      state_path: statePath,
    },
    restored: Boolean(restored?.resumed) && restored?.restored_from === 'bootstrap',
  };
}

export async function main(args: string[] = []): Promise<void> {
  if (args[0] === '--worker') {
    const phase = args[1] === 'resume' ? 'resume' : 'bootstrap';
    const rootArgIndex = args.indexOf('--root');
    const root = rootArgIndex >= 0 ? String(args[rootArgIndex + 1] || DEFAULT_ROOT) : DEFAULT_ROOT;
    await runWorker(safeSoakRoot(root), phase);
    return;
  }

  const report = await runSoakRestartE2E();
  logger.success(
    `[soak-restart-e2e] restored=${report.restored}; bootstrap=${report.bootstrap.pid}; resume=${report.resume.pid}`
  );
  console.log(JSON.stringify(report, null, 2));
}

export const runSoakRestartScript = defineScript({
  name: 'soak:restart-e2e',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'soak_restart_e2e.ts') ||
  isDirectScript(import.meta.url, 'soak_restart_e2e.js')
)
  void runSoakRestartScript();
