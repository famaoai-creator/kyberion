/**
 * WS-02 single env builder for spawning a provider CLI delegation.
 *
 * XP-02 allowlisted provider env + SA-05 delegation depth + (WS-01) a private
 * `GIT_INDEX_FILE` for write-capable (`implementer`) delegations. The
 * allowlist drops every GIT_* var, so the private index is injected after it;
 * it is not a credential and does not widen the XP-02 allowlist.
 */

import { randomUUID } from 'node:crypto';
import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';
import { childDelegationEnv } from '../operation-policy-gate.js';
import {
  buildProviderChildEnv,
  type ProviderId,
  type ProviderPermissionProfileName,
} from './provider-permission-profiles.js';
import { prepareSessionGitIndex } from '../session-git-index.js';
import { markDelegationExecutionStarted } from '../delegation-execution-tracker.js';
import {
  applyProviderCredentialRelay,
  prepareProviderCredentialRelay,
  providerCredentialRelayApplies,
  providerHasCredentialRelayRoute,
  type PreparedProviderCredentialRelay,
} from './provider-credential-relay.js';

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
  /** Credential relay started by {@link buildDelegationSpawnEnvWithRelay}; closed on dispose. */
  credentialRelay?: PreparedProviderCredentialRelay | null;
}

export interface DelegationSpawnEnv {
  env: NodeJS.ProcessEnv;
  /** Release per-spawn resources (the private index). Idempotent. */
  dispose(): void;
  /** Record the spawned child so its private index is not deleted while it runs. */
  attachChild?(pid: number | undefined): void;
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
  // Opt-in (default OFF): the child gets a loopback relay base URL and a
  // per-turn placeholder key instead of the raw API key; torn down on dispose.
  // Every step that can throw runs inside the guard so a started relay never leaks.
  const closeRelay = (): void => input.credentialRelay?.relay.close();
  let env: NodeJS.ProcessEnv;
  try {
    const providerEnv = buildProviderChildEnv({
      provider: input.provider,
      ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
    });
    env = {
      ...applyProviderCredentialRelay({
        provider: input.provider,
        env: providerEnv,
        ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
        prepared: input.credentialRelay ?? null,
      }),
      ...childDelegationEnv(),
    };
  } catch (error) {
    closeRelay();
    throw error;
  }
  if (input.profile !== 'implementer' || !isSessionGitIndexEnabled(input.baseEnv)) {
    return { env, dispose: closeRelay };
  }
  let index: ReturnType<typeof prepareSessionGitIndex>;
  try {
    index = prepareSessionGitIndex({
      sessionId: input.sessionId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
  } catch (error) {
    closeRelay();
    throw error;
  }
  if (!index) return { env, dispose: closeRelay };
  const gitIndex = index;
  let childPid: number | undefined;
  return {
    env: { ...env, ...gitIndex.env },
    attachChild: (pid) => {
      childPid = pid;
      gitIndex.attachChild?.(pid);
    },
    dispose: () => {
      closeRelay();
      gitIndex.dispose(childPid !== undefined ? { childPid } : undefined);
    },
  };
}

/**
 * Launch-site variant that starts the opt-in loopback credential relay
 * (`KYBERION_PROVIDER_CREDENTIAL_RELAY`, default OFF) before building the
 * env, so an API-key-mode claude/codex child gets a placeholder key and a
 * relay base URL; the relay is torn down by `dispose()` (turn end). When no
 * relay applies the env is returned synchronously (no extra event-loop turn
 * before spawn), so callers await only a returned Promise.
 */
export function buildDelegationSpawnEnvWithRelay(
  input: BuildDelegationSpawnEnvInput
): DelegationSpawnEnv | Promise<DelegationSpawnEnv> {
  // Flag off or no relay route: no extra env build, no relay, synchronous.
  if (!providerHasCredentialRelayRoute(input.provider, input.baseEnv)) {
    return buildDelegationSpawnEnv(input);
  }
  const relayInput = {
    provider: input.provider,
    credentialEnv: buildProviderChildEnv({
      provider: input.provider,
      ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
    }),
    ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
  };
  if (!providerCredentialRelayApplies(relayInput)) return buildDelegationSpawnEnv(input);
  // buildDelegationSpawnEnv closes the relay itself if it throws.
  return prepareProviderCredentialRelay(relayInput).then((credentialRelay) =>
    buildDelegationSpawnEnv({ ...input, credentialRelay })
  );
}

/**
 * Spawn a provider child with `spawnEnv`: disposes it when `spawnFn` throws
 * synchronously (then rethrows), otherwise records the child's pid, reports
 * the delegation's execution start (R5) once a process exists, and disposes
 * once it has closed or failed to start.
 */
export function spawnWithDelegationEnv<
  C extends { pid?: number; once(event: 'close' | 'error', listener: () => void): unknown },
>(spawnEnv: DelegationSpawnEnv, spawnFn: () => C): C {
  let child: C;
  try {
    child = spawnFn();
  } catch (error) {
    spawnEnv.dispose();
    throw error;
  }
  spawnEnv.attachChild?.(child.pid);
  // R5: a child process exists, so side effects are now possible. A spawn
  // that never produced a process (ENOENT/EACCES) has no pid and stays pre-start.
  if (child.pid !== undefined) markDelegationExecutionStarted();
  disposeOnChildExit(child, spawnEnv);
  return child;
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
