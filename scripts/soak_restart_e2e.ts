import * as path from 'node:path';
import {
  logger,
  spawnManagedProcess,
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';

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

function writeBootstrapState(root: string): RestartE2EReport['bootstrap'] {
  const heartbeatPath = path.join(root, 'daemon-heartbeat.json');
  const journalPath = path.join(root, 'mission-journal.json');
  const statePath = path.join(root, 'provider-health.json');
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
  const heartbeatPath = path.join(root, 'daemon-heartbeat.json');
  const journalPath = path.join(root, 'mission-journal.json');
  const statePath = path.join(root, 'provider-health.json');
  const existing = safeExistsSync(statePath)
    ? JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string)
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
  safeMkdir(root, { recursive: true });

  if (phase === 'bootstrap') {
    const bootstrapState = writeBootstrapState(root);
    const shutdown = () => {
      safeWriteFile(
        bootstrapState.journal_path,
        JSON.stringify(
          { phase: 'bootstrap', entries: ['boot', 'shutdown'], complete: true },
          null,
          2
        )
      );
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    setInterval(() => {
      safeAppendFileSync(
        bootstrapState.heartbeat_path,
        JSON.stringify({ pid: process.pid, phase, alive: true, ts: new Date().toISOString() }) +
          '\n'
      );
    }, 100).unref?.();
    await new Promise<void>(() => {});
    return;
  }

  writeResumeState(root);
}

function spawnWorker(root: string, phase: 'bootstrap' | 'resume') {
  return spawnManagedProcess({
    resourceId: `soak-restart-e2e:${phase}:${root}`,
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
      root,
    ],
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      stdio: 'ignore',
    },
  }).child;
}

function waitForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (safeExistsSync(filePath)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${filePath}`));
      }
    }, 50);
    timer.unref?.();
  });
}

export async function runSoakRestartE2E(root = DEFAULT_ROOT): Promise<RestartE2EReport> {
  safeRmSync(root, { recursive: true, force: true });
  safeMkdir(root, { recursive: true });

  if (process.env.VITEST === '1' || process.env.NODE_ENV === 'test') {
    const bootstrap = writeBootstrapState(root);
    safeWriteFile(
      bootstrap.journal_path,
      JSON.stringify({ phase: 'bootstrap', entries: ['boot', 'shutdown'], complete: true }, null, 2)
    );
    const resume = writeResumeState(root);
    return {
      timestamp: new Date().toISOString(),
      root,
      bootstrap,
      resume: {
        pid: resume.pid,
        state_path: resume.state_path,
      },
      restored: resume.restored,
    };
  }

  const bootstrap = spawnWorker(root, 'bootstrap');
  const heartbeatPath = path.join(root, 'daemon-heartbeat.json');
  const journalPath = path.join(root, 'mission-journal.json');
  const statePath = path.join(root, 'provider-health.json');
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

  const resume = spawnWorker(root, 'resume');
  const resumeExit = new Promise<void>((resolve, reject) => {
    resume.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`resume exited ${code}`))
    );
    resume.once('error', reject);
  });
  await resumeExit;

  const restored = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
  return {
    timestamp: new Date().toISOString(),
    root,
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') {
    const phase = args[1] === 'resume' ? 'resume' : 'bootstrap';
    const rootArgIndex = args.indexOf('--root');
    const root = rootArgIndex >= 0 ? String(args[rootArgIndex + 1] || DEFAULT_ROOT) : DEFAULT_ROOT;
    await runWorker(root, phase);
    return;
  }

  const report = await runSoakRestartE2E();
  logger.success(
    `[soak-restart-e2e] restored=${report.restored}; bootstrap=${report.bootstrap.pid}; resume=${report.resume.pid}`
  );
  console.log(JSON.stringify(report, null, 2));
}

const isDirect = process.argv[1] && /soak_restart_e2e\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((error) => {
    logger.error(`[soak-restart-e2e] failed: ${(error as Error).message ?? error}`);
    process.exit(1);
  });
}
