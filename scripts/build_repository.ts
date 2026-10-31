#!/usr/bin/env node
// Bootstrap must work before package dist exists: every import is source-relative.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { createLogger } from '../libs/core/logger.js';
import { withCompilerOutputs } from '../libs/core/build-coordination.js';
import {
  BUILD_RECEIPT_SCHEMA_VERSION,
  publishBuildGenerationReceipt,
  type BuildGenerationReceipt,
} from '../libs/core/build-generation.js';
import { PfcController, type RecoveryAttempt } from '../libs/core/pfc/PfcController.js';
import { pathResolver } from '../libs/core/path-resolver.js';
import {
  assertGovernedExec,
  buildSafeExecEnv,
  safeReadFile,
  safeSpawn,
} from '../libs/core/secure-io.js';
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
  // Windows cannot exec a .cmd shim with shell:false, and npm-installed pnpm
  // exposes only .cmd/.ps1 shims on PATH. npm_execpath reports the pnpm that
  // launched the build: a native .exe (standalone) spawns directly by
  // absolute path, a JS entrypoint (npm package) goes through Node.
  if (packageManagerEntrypoint && path.win32.isAbsolute(packageManagerEntrypoint)) {
    if (/\.exe$/i.test(packageManagerEntrypoint)) {
      return { ...stage, command: packageManagerEntrypoint };
    }
    if (/\.[cm]?js$/i.test(packageManagerEntrypoint)) {
      return {
        ...stage,
        command: process.execPath,
        args: [packageManagerEntrypoint, ...stage.args],
      };
    }
  }
  throw new Error('Windows UI build requires the pnpm lifecycle entrypoint; run pnpm build.');
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

export interface BuildInputSnapshot {
  /** sha256 over the compiler input set (source contents + membership). */
  sourceHash: string;
  /** sha256 over tsconfig / manifest / lockfile inputs. */
  configHash: string;
  /** Number of compiler-input files covered. */
  fileCount: number;
  takenAt: string;
}

export interface BuildDependencies {
  run(stage: BuildStage): Promise<void>;
  clean(): void;
  readiness(): Promise<boolean>;
  record(attempt: RecoveryAttempt): void;
  lock<T>(build: () => Promise<T>): Promise<T>;
  /**
   * Snapshot the compiler input set (untracked compiler inputs count — git
   * status is irrelevant). Taken before and after the stage run: a mismatch
   * means sources moved under the build and the output is a mixed
   * generation that must not be called fresh.
   */
  snapshotInputs?(): Promise<BuildInputSnapshot>;
  /** Atomically publish a completed-generation receipt (dist/.build-generation.json). */
  publishReceipt?(receipt: BuildGenerationReceipt): void;
}

async function trySnapshotInputs(deps: BuildDependencies): Promise<BuildInputSnapshot | null> {
  if (!deps.snapshotInputs) return null;
  try {
    return await deps.snapshotInputs();
  } catch (error) {
    logger.warn(
      `compiler input snapshot failed — build generation will stay unverifiable | next: none, the build still runs | evidence: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

/** Tool versions safe to persist in a receipt — no env dumps, no secrets. */
function buildToolVersions(): BuildGenerationReceipt['toolVersions'] {
  const versions: BuildGenerationReceipt['toolVersions'] = { node: process.version };
  try {
    const manifest = JSON.parse(
      safeReadFile(pathResolver.rootResolve('node_modules/typescript/package.json'), {
        encoding: 'utf8',
      }) as string
    ) as { version?: string };
    if (typeof manifest.version === 'string' && manifest.version) {
      versions.typescript = manifest.version;
    }
  } catch {
    /* TypeScript identity unknown — leave it unset rather than guess. */
  }
  const userAgent = process.env.npm_config_user_agent;
  const pnpmMatch = userAgent ? /pnpm\/([\d.]+)/.exec(userAgent) : null;
  if (pnpmMatch?.[1]) versions.pnpm = pnpmMatch[1];
  return versions;
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
    snapshotInputs: async () => {
      const { fingerprintBuildInputs, fingerprintBuildConfigInputs } =
        await import('./check_stale_dist.js');
      const inputs = fingerprintBuildInputs();
      const config = fingerprintBuildConfigInputs();
      return {
        sourceHash: inputs.hash,
        configHash: config.hash,
        fileCount: inputs.fileCount,
        takenAt: new Date().toISOString(),
      };
    },
    publishReceipt: (receipt) => publishBuildGenerationReceipt(receipt),
    ...dependencies,
  };
  await deps.lock(async () => {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const before = await trySnapshotInputs(deps);
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
    const after = await trySnapshotInputs(deps);
    // Concurrent-update detection: the compiler-outputs lock protects dist
    // writes, not source writes — a source that moved under us makes this a
    // mixed generation. A→B→A is unprovable from fingerprints alone, so
    // 'stable_observed' honestly means "before/after fingerprints matched".
    const inputStability =
      !before || !after
        ? 'unverifiable'
        : before.sourceHash === after.sourceHash && before.configHash === after.configHash
          ? 'stable_observed'
          : 'changed_observed';
    let restored = false;
    let reason: string | undefined;
    try {
      restored = await deps.readiness();
    } catch {
      reason = 'Compiler readiness scan failed after build';
    }
    if (inputStability === 'changed_observed') {
      const detail = 'compiler inputs changed during the build — outputs may mix generations';
      logger.warn(
        `${detail} | next: re-run the build once source writes settle | evidence: before=${before?.sourceHash.slice(0, 12)} after=${after?.sourceHash.slice(0, 12)}`
      );
      reason = reason ? `${reason}; ${detail}` : detail;
    } else if (inputStability === 'unverifiable') {
      logger.warn(
        'compiler input stability could not be verified — no build-generation receipt will be published for this run'
      );
    }
    // A completed-generation receipt is published only when the existing
    // readiness checks pass AND the input generation held stable; failed,
    // aborted or mixed builds never overwrite the last good receipt.
    if (restored && inputStability === 'stable_observed' && before && deps.publishReceipt) {
      try {
        deps.publishReceipt({
          schemaVersion: BUILD_RECEIPT_SCHEMA_VERSION,
          generationId: id,
          mode,
          startedAt,
          finishedAt: new Date().toISOString(),
          result: 'completed',
          inputFingerprint: before.sourceHash,
          configFingerprint: before.configHash,
          toolVersions: buildToolVersions(),
          inputStability: 'stable_observed',
        });
      } catch (error) {
        logger.warn(
          `build-generation receipt publish failed — the build result is unaffected | evidence: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    deps.record({
      id,
      passed: true,
      restored: restored && inputStability !== 'changed_observed',
      ...(reason ? { reason } : {}),
    });
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
