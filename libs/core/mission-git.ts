/**
 * scripts/refactor/mission-git.ts
 * Git operation utilities for Mission micro-repositories.
 */

import * as path from 'node:path';
import { safeExec, safeExecResult, safeExistsSync } from './secure-io.js';
import { logger } from './core.js';
import { resolveRole } from './authority.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { rootDir } from './path-resolver.js';
import type { SessionGitIndex } from './session-git-index.js';
import { checkWorkspaceBudget, type WorkspaceBudgetOptions } from './workspace-budget.js';
import {
  deleteRegisteredWorkspace,
  registerWorkspace,
  WORKTREES_ROOT_REPO_PATH,
  type WorkspaceLedgerOptions,
  type WorkspaceOwner,
  type WorkspaceRecord,
} from './workspace-ledger.js';

export function getGitHash(cwd: string): string {
  return safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim();
}

export function deriveMissionBranchName(missionId: string): string {
  const normalized = missionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `mission/${normalized || 'unnamed'}`;
}

export function initMissionRepo(missionDir: string, missionId?: string): void {
  if (!safeExistsSync(path.join(missionDir, '.git'))) {
    logger.info(`🌱 Initializing independent Git repo for mission at ${missionDir}...`);
    safeExec('git', ['init'], { cwd: missionDir });
    safeExec('git', ['config', 'user.name', 'Kyberion Sovereign Entity'], { cwd: missionDir });
    safeExec('git', ['config', 'user.email', 'sovereign@kyberion.local'], { cwd: missionDir });
    safeExec('git', ['add', '.'], { cwd: missionDir });
    safeExec('git', ['commit', '-m', 'chore: initial mission state'], { cwd: missionDir });
    safeExec(
      'git',
      ['branch', '-m', deriveMissionBranchName(missionId || path.basename(missionDir))],
      { cwd: missionDir }
    );
  }
}

export function getCurrentBranch(cwd: string): string {
  try {
    return safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).trim();
  } catch (_) {
    return 'detached';
  }
}

/** Roles allowed to commit on behalf of a mission (the owner path). */
const SESSION_INDEX_COMMIT_ROLES = new Set(['mission_controller', 'orchestrator', 'mission_owner']);

export interface SessionIndexCommitResult {
  /** New commit sha, or null when the private index had nothing to commit. */
  sha: string | null;
  /** Paths the commit changed (the real index is refreshed for exactly these). */
  paths: string[];
}

function assertSessionIndexCommitOwner(): void {
  assertMissionOwnerPath('commit a session index');
}

function assertMissionOwnerPath(action: string): void {
  const depth = Number(getRegisteredEnvText('KYBERION_DELEGATION_DEPTH'));
  if (Number.isFinite(depth) && depth > 0) {
    throw new Error(
      `[SESSION_INDEX_OWNER_ONLY] delegated workers may not ${action}; mission owner only`
    );
  }
  const role = resolveRole();
  if (!role || !SESSION_INDEX_COMMIT_ROLES.has(role)) {
    throw new Error(
      `[SESSION_INDEX_OWNER_ONLY] role ${role ?? 'unknown'} may not ${action} (mission owner only)`
    );
  }
}

/**
 * WS-03: commit what a worker session staged in its private index. Owner path
 * only. A private index is a full tree snapshot, so committing it after HEAD
 * moved would silently revert other sessions' commits — refuse instead.
 */
export function commitFromSessionIndex(
  idx: SessionGitIndex,
  message: string
): SessionIndexCommitResult {
  assertSessionIndexCommitOwner();
  const cwd = idx.repoRoot;
  const head = safeExecResult('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  const currentSha = head.status === 0 ? head.stdout.trim() || null : null;
  if (currentSha !== idx.baselineSha) {
    throw new Error(
      `[SESSION_INDEX_STALE] HEAD moved from ${idx.baselineSha ?? '(none)'} to ${currentSha ?? '(none)'} since session ${idx.sessionId} started; re-stage on a fresh index instead`
    );
  }
  const env = idx.env;
  const staged = safeExec(
    'git',
    ['diff', '--cached', '--name-only', '-z', ...(currentSha ? [currentSha] : []), '--'],
    { cwd, env }
  )
    .split('\0')
    .filter(Boolean);
  if (currentSha && staged.length === 0) return { sha: null, paths: [] };
  safeExec('git', ['commit', '-q', '-m', message], { cwd, env });
  const sha = getGitHash(cwd);
  const paths =
    staged.length > 0
      ? staged
      : safeExec('git', ['ls-files', '-z'], { cwd, env }).split('\0').filter(Boolean);
  // Bring the shared index in line with the new HEAD for the committed paths
  // only, leaving anything else staged there untouched.
  if (paths.length > 0) {
    safeExec('git', ['reset', '-q', sha, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      cwd,
      input: `${paths.join('\0')}\0`,
    });
  }
  return { sha, paths };
}

export interface CreateSessionWorktreeInput {
  sessionId: string;
  owner?: Omit<WorkspaceOwner, 'session_id'>;
  /** Checkout to branch from; defaults to the Kyberion root. */
  repoRoot?: string;
  /** Commit-ish to check out (detached); defaults to HEAD. */
  ref?: string;
}

export interface CreateSessionWorktreeOptions {
  /** Test seam: directory under which `<sessionId>` is created (defaults to `.worktrees/`). */
  root?: string;
  ledger?: WorkspaceLedgerOptions;
  budget?: Omit<WorkspaceBudgetOptions, keyof WorkspaceLedgerOptions>;
}

const SESSION_WORKTREE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * WS-03: opt-in per-session git worktree for parallel writers. Created on the
 * owner/orchestrator path only (never by worker CLIs), registered in the
 * workspace ledger as `git-worktree` before `git worktree add`, and removed
 * later only through `deleteRegisteredWorkspace` (`git worktree remove`).
 */
export function createSessionWorktree(
  input: CreateSessionWorktreeInput,
  options: CreateSessionWorktreeOptions = {}
): WorkspaceRecord {
  assertMissionOwnerPath('create a session worktree');
  if (!SESSION_WORKTREE_ID_PATTERN.test(input.sessionId)) {
    throw new Error(`[SESSION_WORKTREE] invalid session id: ${input.sessionId}`);
  }
  const repoRoot = input.repoRoot ?? rootDir();
  const ledger = options.ledger ?? {};
  const dir = path.join(
    options.root ?? path.join(rootDir(), WORKTREES_ROOT_REPO_PATH),
    input.sessionId
  );
  const budget = checkWorkspaceBudget(dir, 0, { ...ledger, ...options.budget });
  if (!budget.allowed) {
    throw new Error(
      `[SESSION_WORKTREE_BUDGET] workspace budget denied a worktree (${budget.reason})`
    );
  }
  const record = registerWorkspace(
    {
      path: dir,
      kind: 'git-worktree',
      owner: { ...(input.owner ?? {}), session_id: input.sessionId },
      repoRoot,
    },
    ledger
  );
  const added = safeExecResult(
    'git',
    ['worktree', 'add', '--detach', record.path, input.ref ?? 'HEAD'],
    { cwd: repoRoot, timeoutMs: 120_000 }
  );
  if (added.status !== 0) {
    deleteRegisteredWorkspace(record.id, ledger);
    throw new Error(`[SESSION_WORKTREE] git worktree add failed: ${added.stderr.trim()}`);
  }
  return record;
}
