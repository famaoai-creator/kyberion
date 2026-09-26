/**
 * WS-02 single env builder for spawning a provider CLI delegation.
 *
 * XP-02 allowlisted provider env + SA-05 delegation depth + (WS-01) a private
 * `GIT_INDEX_FILE` for write-capable (`implementer`) delegations. The
 * allowlist drops every GIT_* var, so the private index is injected after it;
 * it is not a credential and does not widen the XP-02 allowlist.
 */

import { randomUUID } from 'node:crypto';
import { getRegisteredEnvText, isVitestProcess } from './foundation/env.js';
import { childDelegationEnv } from './operation-policy-gate.js';
import {
  buildProviderChildEnv,
  type ProviderId,
  type ProviderPermissionProfileName,
} from './provider-permission-profiles.js';
import { prepareSessionGitIndex } from './session-git-index.js';

export const SESSION_GIT_INDEX_ENV_VAR = 'KYBERION_SESSION_GIT_INDEX';

export interface BuildDelegationSpawnEnvInput {
  provider: ProviderId;
  /** Working directory of the child; defaults to this process's cwd. */
  cwd?: string;
  sessionId: string;
  /** Effective permission profile; only `implementer` gets a private index. */
  profile?: ProviderPermissionProfileName;
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface DelegationSpawnEnv {
  env: NodeJS.ProcessEnv;
  /** Release per-spawn resources (the private index). Idempotent. */
  dispose(): void;
}

/** A fresh session id for a provider CLI spawn that has none of its own. */
export function newDelegationSessionId(provider: ProviderId): string {
  return `${provider}-${randomUUID()}`;
}

/**
 * On by default; `KYBERION_SESSION_GIT_INDEX=0` disables it. Hermetic guard:
 * under Vitest it stays off unless a test opts in with `=1`, so backend
 * suites never copy the real checkout's index into shared runtime state.
 */
export function isSessionGitIndexEnabled(baseEnv?: NodeJS.ProcessEnv): boolean {
  const raw = getRegisteredEnvText(SESSION_GIT_INDEX_ENV_VAR, baseEnv ? { env: baseEnv } : {});
  if (raw?.trim() === '0') return false;
  return !isVitestProcess() || raw?.trim() === '1';
}

export function buildDelegationSpawnEnv(input: BuildDelegationSpawnEnvInput): DelegationSpawnEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildProviderChildEnv({
      provider: input.provider,
      ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
    }),
    ...childDelegationEnv(),
  };
  if (input.profile !== 'implementer' || !isSessionGitIndexEnabled(input.baseEnv)) {
    return { env, dispose: () => undefined };
  }
  const index = prepareSessionGitIndex({
    sessionId: input.sessionId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  if (!index) return { env, dispose: () => undefined };
  return {
    env: { ...env, ...index.env },
    dispose: () => index.dispose(),
  };
}

/**
 * Dispose `spawnEnv` once the child has closed or failed to start. Callers
 * also dispose on their wall-clock-budget timeout path; dispose is idempotent.
 */
export function disposeOnChildExit(
  child: { once(event: 'close' | 'error', listener: () => void): unknown },
  spawnEnv: DelegationSpawnEnv
): void {
  child.once('close', () => spawnEnv.dispose());
  child.once('error', () => spawnEnv.dispose());
}
