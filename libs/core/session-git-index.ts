/**
 * WS-01 per-session private git index.
 *
 * A write-capable delegation gets its own `GIT_INDEX_FILE`, seeded from the
 * checkout's real index, so a worker's accidental `git add` stages into a
 * private snapshot instead of the index every other concurrent session
 * shares. Workers still never commit; the mission owner may commit a session
 * index through `commitFromSessionIndex` (mission-git.ts), which refuses when
 * HEAD moved away from `baselineSha`.
 */

import * as path from 'node:path';
import { createLogger } from './logger.js';
import { shared } from './path-resolver.js';
import {
  safeCopyFileSync,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
} from './secure-io.js';
import { checkWorkspaceBudget, type WorkspaceBudgetOptions } from './workspace-budget.js';
import {
  deleteRegisteredWorkspace,
  GIT_INDEXES_ROOT_SUBPATH,
  registerWorkspace,
  releaseWorkspace,
  type WorkspaceLedgerOptions,
  type WorkspaceOwner,
} from './workspace-ledger.js';

const logger = createLogger('session-git-index');

export interface SessionGitIndex {
  sessionId: string;
  /** Absolute top-level directory of the checkout the index belongs to. */
  repoRoot: string;
  /** Absolute path of the private index file. */
  indexPath: string;
  /** HEAD when the index was seeded; null for a repository without commits. */
  baselineSha: string | null;
  /** Workspace ledger id of the index directory. */
  workspaceId: string;
  env: { GIT_INDEX_FILE: string };
  /** Release the ledger entry and delete the index directory. Idempotent. */
  dispose(): void;
}

export interface PrepareSessionGitIndexInput {
  sessionId: string;
  cwd?: string;
  owner?: Omit<WorkspaceOwner, 'session_id'>;
}

export interface PrepareSessionGitIndexOptions {
  /** Test seam: directory under which `<sessionId>/index` is created. */
  root?: string;
  ledger?: WorkspaceLedgerOptions;
  budget?: Omit<WorkspaceBudgetOptions, keyof WorkspaceLedgerOptions>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function git(cwd: string, args: string[], env?: Record<string, string>) {
  return safeExecResult('git', args, { cwd, timeoutMs: 30_000, ...(env ? { env } : {}) });
}

function gitText(cwd: string, args: string[]): string | null {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function realIndexBytes(realIndex: string): number {
  try {
    return safeExistsSync(realIndex) ? safeLstat(realIndex).size : 0;
  } catch {
    return 0;
  }
}

/**
 * Seed from the real index (keeps its stat cache). A linked worktree's index
 * may live outside the repository's secure-io scope; fall back to building
 * the index from HEAD with git itself.
 */
function seedIndex(
  repoRoot: string,
  realIndex: string,
  indexPath: string,
  baselineSha: string | null
): void {
  if (safeExistsSync(realIndex)) {
    try {
      safeCopyFileSync(realIndex, indexPath);
      return;
    } catch (error) {
      logger.warn(
        `copying ${realIndex} failed (${error instanceof Error ? error.message : String(error)}); seeding from HEAD`
      );
    }
  }
  if (!baselineSha) return;
  const result = git(repoRoot, ['read-tree', baselineSha], { GIT_INDEX_FILE: indexPath });
  if (result.status !== 0) {
    throw new Error(`git read-tree failed: ${result.stderr.trim()}`);
  }
}

/**
 * Create a private index for `sessionId` in the checkout containing `cwd`.
 * Returns null (never throws) when `cwd` is not inside a git work tree, the
 * workspace budget denies the copy, or seeding fails.
 */
export function prepareSessionGitIndex(
  input: PrepareSessionGitIndexInput,
  options: PrepareSessionGitIndexOptions = {}
): SessionGitIndex | null {
  const { sessionId } = input;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    logger.warn(`invalid session id, skipping private index: ${sessionId}`);
    return null;
  }
  const cwd = path.resolve(input.cwd ?? process.cwd());
  let workspaceId: string | null = null;
  const ledger = options.ledger ?? {};
  try {
    if (gitText(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
    const repoRoot = gitText(cwd, ['rev-parse', '--show-toplevel']);
    const gitPath = gitText(cwd, ['rev-parse', '--git-path', 'index']);
    if (!repoRoot || !gitPath) return null;
    const realIndex = path.resolve(cwd, gitPath);
    const baselineSha = gitText(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']) || null;

    const dir = path.join(options.root ?? shared(GIT_INDEXES_ROOT_SUBPATH), sessionId);
    const budget = checkWorkspaceBudget(dir, realIndexBytes(realIndex), {
      ...ledger,
      ...options.budget,
    });
    if (!budget.allowed) {
      logger.warn(
        `workspace budget denied a private index for ${sessionId} (${budget.reason}); the session shares the real index`
      );
      return null;
    }

    const record = registerWorkspace(
      {
        path: dir,
        kind: 'git-index',
        owner: { ...(input.owner ?? {}), session_id: sessionId },
      },
      ledger
    );
    workspaceId = record.id;
    safeMkdir(record.path, { recursive: true });
    const indexPath = path.join(record.path, 'index');
    seedIndex(repoRoot, realIndex, indexPath, baselineSha);

    let disposed = false;
    const id = record.id;
    return {
      sessionId,
      repoRoot: path.resolve(repoRoot),
      indexPath,
      baselineSha,
      workspaceId: id,
      env: { GIT_INDEX_FILE: indexPath },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        try {
          releaseWorkspace(id, ledger);
          deleteRegisteredWorkspace(id, ledger);
        } catch (error) {
          logger.warn(
            `dispose failed for ${sessionId}; the janitor sweep reclaims it: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
    };
  } catch (error) {
    logger.warn(
      `private index unavailable for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    if (workspaceId) {
      try {
        deleteRegisteredWorkspace(workspaceId, ledger);
      } catch {
        // left to the janitor sweep
      }
    }
    return null;
  }
}
