/**
 * vcs-backend seam — the pluggable command-runner extension point beneath the
 * shared typed-verb git surface (Step-4 of the distributed runtime
 * architecture).
 *
 * `libs/core/vcs/git.ts` exposes typed verbs (status/diff/log/commit/worktree/
 * governed push-fetch-pull) that all delegate to a `VcsCommandRunner`. Today
 * the only runner is the local git CLI via governed `safeExecResult`.
 * Distributed runtimes need the same verb surface over a different execution
 * substrate — a remote workspace, a VCS host API, or an in-process engine —
 * without changing call sites.
 *
 * Providers register by id (`local-git` builtin, `memory` for hermetic tests,
 * libgit2/github-api later); selection order is governed data
 * (`seam-provider-selection/vcs-backend.json` `default_chains`), never a
 * hard-coded preference list.
 *
 * The contract is deliberately the command-runner envelope, not a per-verb
 * interface: the typed verb layer already owns argv construction, flag
 * hygiene (`assertNotFlagLike`), cwd-scope assertions and external-operation
 * governance (`governVcsCommand`). Backends only decide WHERE `command args`
 * executes and MUST honour the `VcsCommandResult` envelope — non-zero exits
 * are results, not thrown errors, so callers keep their existing checks.
 * Per-mission-repo plumbing (libs/core/mission/mission-git.ts) intentionally
 * stays direct: mission repos are the owner-only atomic-rollback contract,
 * not this shared surface.
 */

import { createProviderRegistry } from '../provider-registry.js';
import type { SeamProviderMetadata } from '../seam.js';
import { getSeamSelectionPolicy } from '../seam-provider-selection.js';
import type { SafeExecOptions } from '../secure-io.js';

export const VCS_BACKEND_SEAM = 'vcs-backend';
/** Builtin default provider id; also the governed `default_provider`. */
export const LOCAL_GIT_BACKEND_ID = 'local-git';

/** Captured result of one backend command invocation. */
export interface VcsCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export type VcsCommandRunner = (
  command: string,
  args: string[],
  options?: SafeExecOptions
) => VcsCommandResult;

export interface VcsBackend {
  readonly id: string;
  /**
   * Execute `command args` under `options` and return the captured envelope.
   * MUST NOT throw for non-zero exits — callers branch on `status`/`error`.
   */
  run: VcsCommandRunner;
}

const vcsBackendRegistry = createProviderRegistry<VcsBackend>({
  seam: VCS_BACKEND_SEAM,
  owner: 'libs/core/vcs/vcs-backend.ts',
  source: 'vcs-backend-extension',
  missingIdError: 'VcsBackend must have a non-empty id',
});

export function registerVcsBackend(
  backend: VcsBackend,
  metadata?: SeamProviderMetadata
): () => void {
  return vcsBackendRegistry.register(backend, metadata);
}

export function listVcsBackends(): VcsBackend[] {
  return vcsBackendRegistry.list();
}

export function getVcsBackend(id: string): VcsBackend | undefined {
  return vcsBackendRegistry.get(id);
}

export function resetVcsBackends(): void {
  vcsBackendRegistry.reset();
}

/**
 * Resolve the backend for a caller. An explicit selector always wins; without
 * one the governed `default_chains.default` ordering picks the first
 * registered provider, falling back to `local-git` then to whatever is
 * registered. Throws when nothing is registered — local-git is installed by
 * importing `local-git-backend.ts`, which the typed verb surface relies on.
 */
export function resolveVcsBackend(selector?: string): VcsBackend {
  const explicit = selector?.trim();
  if (explicit) {
    const backend = vcsBackendRegistry.get(explicit);
    if (!backend) {
      throw new Error(
        `[VCS_BACKEND] unknown backend '${explicit}' — registered: ${
          vcsBackendRegistry
            .list()
            .map((b) => b.id)
            .join(', ') || '(none)'
        }`
      );
    }
    return backend;
  }
  const chain = getSeamSelectionPolicy(VCS_BACKEND_SEAM)?.default_chains?.default ?? [
    LOCAL_GIT_BACKEND_ID,
  ];
  for (const id of chain) {
    const backend = vcsBackendRegistry.get(id);
    if (backend) return backend;
  }
  const first = vcsBackendRegistry.list()[0];
  if (first) return first;
  throw new Error(
    '[VCS_BACKEND] no backend registered — import @agent/core/vcs/local-git-backend (or register one)'
  );
}

/**
 * Stable runner for the `run` parameter default on every typed verb — resolves
 * the governed backend lazily per invocation, so an explicit `run` argument
 * still wins (tests, callers with their own runner dependency) while the
 * default path is policy-governed.
 */
export const vcsDefaultRunner: VcsCommandRunner = (command, args, options) =>
  resolveVcsBackend().run(command, args, options);
