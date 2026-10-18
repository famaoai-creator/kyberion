#!/usr/bin/env node
// Bootstrap must work before package dist exists: every import is source-relative.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { createLogger } from '../libs/core/logger.js';
import { withCompilerOutputs } from '../libs/core/build-coordination.js';
import { PfcController, type RecoveryAttempt } from '../libs/core/pfc/PfcController.js';
import { pathResolver } from '../libs/core/path-resolver.js';
import { assertGovernedExec, buildSafeExecEnv, safeSpawn } from '../libs/core/secure-io.js';
import { defineScript, isDirectScript } from '../libs/core/script-harness.js';
import { runClean } from './clean.js';

const logger = createLogger('build-repository');

export type BuildMode = 'all' | 'packages' | 'repo';
export interface BuildStage {
  name: string;
  command: string;
  args: string[];
}
const packages: BuildStage[] = [
  {
    name: 'packages',
    command: 'node',
    args: ['node_modules/typescript/bin/tsc', '-b', 'tsconfig.packages.json'],
  },
  { name: 'package-scopes', command: 'node', args: ['scripts/write_core_dist_scope.mjs', '--run'] },
];
const repo: BuildStage[] = [
  {
    name: 'repository',
    command: 'node',
    args: ['--max-old-space-size=6144', 'node_modules/typescript/bin/tsc', '-b', 'tsconfig.json'],
  },
  {
    name: 'repository-scopes',
    command: 'node',
    args: ['scripts/write_core_dist_scope.mjs', '--run'],
  },
  { name: 'bundles', command: 'node', args: ['scripts/bundle_entrypoints.mjs'] },
];
const postBuild: BuildStage[] = [
  {
    name: 'knowledge-manifest',
    command: 'node',
    args: ['dist/scripts/generate_knowledge_index.js', '--manifest-only', '--quiet'],
  },
  { name: 'ui', command: 'pnpm', args: ['run', 'build:ui'] },
  { name: 'source-shadows', command: 'node', args: ['dist/scripts/check_source_shadows.js'] },
];

/** Injectable boundaries keep shutdown tests from signalling the test process. */
export interface BuildStageRuntime {
  spawn: typeof safeSpawn;
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  offSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  signalGroup(pid: number, signal: NodeJS.Signals): void;
  windows: boolean;
  packageManagerEntrypoint?: string;
}

export function resolveBuildCommand(
  stage: BuildStage,
  windows: boolean,
  packageManagerEntrypoint?: string
): BuildStage {
  if (!windows || stage.command !== 'pnpm') return stage;
  // Windows cannot exec a .cmd shim with shell:false. pnpm supplies its JS
  // entrypoint to lifecycle scripts, so keep argv boundaries without a shell.
  if (
    !packageManagerEntrypoint ||
    !path.win32.isAbsolute(packageManagerEntrypoint) ||
    !/\.[cm]?js$/i.test(packageManagerEntrypoint)
  ) {
    throw new Error('Windows UI build requires the pnpm lifecycle entrypoint; run pnpm build.');
  }
  return { ...stage, command: process.execPath, args: [packageManagerEntrypoint, ...stage.args] };
}

export async function runBuildStage(
  stage: BuildStage,
  overrides: Partial<BuildStageRuntime> = {}
): Promise<void> {
  const runtime: BuildStageRuntime = {
    spawn: safeSpawn,
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    offSignal: (signal, handler) => {
      process.off(signal, handler);
    },
    signalGroup: (pid, signal) => {
      process.kill(-pid, signal);
    },
    windows: process.platform === 'win32',
    packageManagerEntrypoint: process.env.npm_execpath,
    ...overrides,
  };
  const command = resolveBuildCommand(stage, runtime.windows, runtime.packageManagerEntrypoint);
  assertGovernedExec(command.command, command.args);
  await new Promise<void>((resolve, reject) => {
    let cancelled: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let outputBytes = 0;
    let cleaned = false;
    let child: ReturnType<typeof safeSpawn>;
    const signalChild = (signal: NodeJS.Signals): void => {
      try {
        if (!runtime.windows && child.pid) runtime.signalGroup(child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited: still wait for close before releasing the lock. */
      }
    };
    const cancel = (reason: string, signal: NodeJS.Signals): void => {
      if (cancelled) return;
      cancelled = reason;
      signalChild(signal);
      escalation = setTimeout(() => signalChild('SIGKILL'), 5000);
    };
    const interrupt = () => cancel('SIGINT', 'SIGINT');
    const terminate = () => cancel('SIGTERM', 'SIGTERM');
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      runtime.offSignal('SIGINT', interrupt);
      runtime.offSignal('SIGTERM', terminate);
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
    };
    const logOutput = (chunk: Buffer | string): void => {
      const text = String(chunk);
      const remaining = 30 * 1024 * 1024 - outputBytes;
      if (remaining <= 0) return;
      const bounded = text.slice(0, Math.min(remaining, 8192));
      outputBytes += Buffer.byteLength(text);
      if (bounded.trim()) logger.info(bounded.trim());
    };
    try {
      child = runtime.spawn(command.command, command.args, {
        cwd: pathResolver.rootDir(),
        env: buildSafeExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !runtime.windows,
      });
      runtime.onSignal('SIGINT', interrupt);
      runtime.onSignal('SIGTERM', terminate);
      timeout = setTimeout(() => cancel('timeout', 'SIGTERM'), 20 * 60_000);
      child.stdout?.on('data', logOutput);
      child.stderr?.on('data', logOutput);
      child.once('error', (error) => {
        if (child.pid) cancel(`process error (${error.name})`, 'SIGTERM');
        else {
          cleanup();
          reject(new Error(`${stage.name} failed to spawn (${error.name})`));
        }
      });
      child.once('close', (code, signal) => {
        cleanup();
        if (cancelled) reject(new Error(`${stage.name} cancelled (${cancelled})`));
        else if (code !== 0)
          reject(new Error(`${stage.name} failed: exit ${code}${signal ? ` (${signal})` : ''}`));
        else resolve();
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export interface BuildDependencies {
  run(stage: BuildStage): Promise<void>;
  clean(): void;
  readiness(): Promise<boolean>;
  record(attempt: RecoveryAttempt): void;
  lock<T>(build: () => Promise<T>): Promise<T>;
}

export async function buildRepository(
  mode: BuildMode,
  dependencies: Partial<BuildDependencies> = {}
): Promise<void> {
  const deps: BuildDependencies = {
    run: runBuildStage,
    clean: () => runClean(),
    readiness: async () => {
      const [{ checkDistWorkspaceImports }, { findStaleDistTargets }] = await Promise.all([
        import('./check_dist_workspace_imports.js'),
        import('./check_stale_dist.js'),
      ]);
      return checkDistWorkspaceImports().length === 0 && findStaleDistTargets().stale.length === 0;
    },
    record: (attempt) =>
      new PfcController(
        pathResolver.rootResolve('active/shared/runtime/state/pfc-state.json')
      ).recordRecoveryAttempt('L2', attempt),
    lock: withCompilerOutputs,
    ...dependencies,
  };
  await deps.lock(async () => {
    const id = randomUUID();
    try {
      if (mode === 'all') deps.clean();
      for (const stage of mode === 'packages'
        ? packages
        : mode === 'repo'
          ? repo
          : [...packages, ...repo]) {
        await deps.run(stage);
      }
    } catch (error) {
      deps.record({
        id,
        passed: false,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    let restored = false;
    let reason: string | undefined;
    try {
      restored = await deps.readiness();
    } catch {
      reason = 'Compiler readiness scan failed after build';
    }
    deps.record({ id, passed: true, restored, ...(reason ? { reason } : {}) });
    // These failures do not indicate a compiler recovery failure.
    if (mode === 'all') for (const stage of postBuild) await deps.run(stage);
  });
}

const run = defineScript({
  name: 'build-repository',
  async run(context) {
    const mode = context.positional[0] ?? 'all';
    if (mode !== 'all' && mode !== 'packages' && mode !== 'repo')
      throw new Error(`Unknown build mode: ${mode}`);
    await buildRepository(mode);
  },
});
if (
  isDirectScript(import.meta.url, 'build_repository.ts') ||
  isDirectScript(import.meta.url, 'build_repository.js')
)
  void run();
