/**
 * C7 shared child-process helper (`process:supervise_child`).
 *
 * Unifies the hand-written `spawn` / `kill('SIGTERM')` sites in voice-hub
 * (`server.ts`, `speech-synthesis-runtime.ts`, `voice-stt-transcribe.ts`).
 *
 * Behavior contract — identical to the previous per-site literals:
 * - default `cwd` = repository root, default `env` = `buildSafeExecEnv`
 *   with `KYBERION_PROJECT_ROOT`; callers keep passing their own `stdio`;
 * - stop signal defaults to `SIGTERM` (every current site kills SIGTERM);
 * - `stopSupervisedChild` mirrors the previous `try { kill } catch`
 *   shape: false only when there is no child or the kill throws.
 */

import type { ChildProcess, SpawnOptions } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { buildSafeExecEnv, safeSpawn } from '@agent/core/secure-io';

export type SupervisedStopSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

export interface SupervisedSpawnOptions {
  /** Defaults to the repository root (previous per-site literal). */
  cwd?: string;
  /** Defaults to `buildSafeExecEnv({ KYBERION_PROJECT_ROOT })`. */
  env?: NodeJS.ProcessEnv;
  /** Passed through; no default change (callers keep their stdio). */
  stdio?: SpawnOptions['stdio'];
  /** Recorded so `stopSupervisedChild(child)` reuses it. Default `SIGTERM`. */
  stopSignal?: SupervisedStopSignal;
}

const childStopSignals = new WeakMap<ChildProcess, SupervisedStopSignal>();

/** Spawn with the governed cwd/env defaults. */
export function spawnSupervisedChild(
  cmd: string,
  args: string[],
  options: SupervisedSpawnOptions = {}
): ChildProcess {
  const child = safeSpawn(cmd, args, {
    cwd: options.cwd ?? pathResolver.rootDir(),
    env: options.env ?? buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  childStopSignals.set(child, options.stopSignal ?? 'SIGTERM');
  return child;
}

/**
 * Stop a supervised child. Returns false only when there is no child or the
 * kill itself throws — same contract as the previous inline `child.kill`.
 */
export function stopSupervisedChild(
  child: ChildProcess | null | undefined,
  signal?: SupervisedStopSignal
): boolean {
  if (!child) return false;
  try {
    child.kill(signal ?? childStopSignals.get(child) ?? 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
