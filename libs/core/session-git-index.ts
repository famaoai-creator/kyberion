/**
 * WS-01 per-session private git index.
 *
 * A write-capable delegation gets its own `GIT_INDEX_FILE`, seeded from HEAD
 * (never from the shared index, which may hold other sessions' staged work),
 * so a worker's accidental `git add` stages into a private snapshot instead of
 * the index every other concurrent session shares. The mission owner commits
 * a session index through `commitFromSessionIndex` (mission-git.ts). Nothing
 * stops a worker from committing with its private index anyway, so dispose
 * brings the shared index up to the moved HEAD for the paths those commits
 * changed — otherwise the owner's next commit would silently revert them.
 * A reconcile that keeps failing (another git process holding `index.lock`)
 * is audited as failed and recorded on the ledger entry as pending; the entry
 * is kept until a later dispose or the janitor sweep completes it.
 */

import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { createLogger } from './logger.js';
import { shared } from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeLstat, safeMkdir } from './secure-io.js';
import { checkWorkspaceBudget, type WorkspaceBudgetOptions } from './workspace-budget.js';
import {
  annotateWorkspace,
  deleteRegisteredWorkspace,
  GIT_INDEXES_ROOT_SUBPATH,
  listWorkspaces,
  registerWorkspace,
  releaseWorkspace,
  type WorkspaceLedgerOptions,
  type WorkspaceOwner,
  type WorkspaceRecord,
} from './workspace-ledger.js';
import {
  isRecordedChildAlive,
  processStartMarker,
  type ProcessIdentityProbe,
} from './workspace-process-identity.js';

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
  /** Record the delegated child so no sweep deletes the index while it runs. */
  attachChild(pid: number | undefined): void;
  /**
   * Reconcile the shared index with commits made through this index, release
   * the ledger entry and delete the index directory. While `childPid` (or its
   * process group) is still alive the directory is kept for the janitor
   * sweep; a later call deletes it. Idempotent.
   */
  dispose(options?: SessionGitIndexDisposeOptions): void;
}

export interface SessionGitIndexDisposeOptions {
  childPid?: number;
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
  /** Test seam: process liveness / start-marker probes. */
  processProbe?: ProcessIdentityProbe;
  /** Test seam: audit sink for shared-index reconciliation (defaults to the audit chain). */
  audit?: (entry: SharedIndexReconcileAudit) => void;
  /** Test seam: `index.lock` retry schedule of the shared-index reconcile. */
  reconcileRetry?: ReconcileRetryOptions;
}

export interface SharedIndexReconcileAudit {
  sessionId: string;
  fromSha: string | null;
  /** HEAD the shared index was moved to; null when the failure left it unknown. */
  toSha: string | null;
  result: 'completed' | 'failed';
  /** Paths whose shared-index entry was moved to the new HEAD. */
  updated: string[];
  /** Paths left alone because the shared index held other staged work for them. */
  skipped: string[];
  error?: string;
}

export interface ReconcileRetryOptions {
  /** Waits (ms) before each retry while another git process holds `index.lock`. */
  delaysMs?: number[];
  /** Synchronous wait; defaults to a blocking sleep. */
  sleep?: (ms: number) => void;
}

const INDEX_LOCK_RETRY_DELAYS_MS = [50, 150, 400];
const INDEX_LOCKED = /index\.lock/;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function git(cwd: string, args: string[], env?: Record<string, string>) {
  return safeExecResult('git', args, { cwd, timeoutMs: 30_000, ...(env ? { env } : {}) });
}

function gitText(cwd: string, args: string[]): string | null {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function realIndexBytes(realIndex: string): number {
  try {
    return safeExistsSync(realIndex) ? safeLstat(realIndex).size : 0;
  } catch {
    return 0;
  }
}

/**
 * Seed from HEAD, not from the shared index: a copy of the shared index would
 * carry other sessions' staged changes into this session's commit.
 */
function seedIndex(repoRoot: string, indexPath: string, baselineSha: string | null): void {
  const result = git(
    repoRoot,
    baselineSha ? ['read-tree', baselineSha] : ['read-tree', '--empty'],
    {
      GIT_INDEX_FILE: indexPath,
    }
  );
  if (result.status !== 0) {
    throw new Error(`git read-tree failed: ${result.stderr.trim()}`);
  }
}

interface TreeEntry {
  mode: string;
  oid: string;
}

const ABSENT_MODE = /^0+$/;

/** `git diff-tree -r -z --no-renames` raw output → path → [before, after] (null = absent). */
function parseRawDiff(out: string): Map<string, [TreeEntry | null, TreeEntry | null]> {
  const changes = new Map<string, [TreeEntry | null, TreeEntry | null]>();
  const tokens = out.split('\0');
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [oldMode, newMode, oldOid, newOid] = tokens[i].replace(/^:/, '').split(' ');
    const file = tokens[i + 1];
    if (!file || !newOid) continue;
    changes.set(file, [
      ABSENT_MODE.test(oldMode) ? null : { mode: oldMode, oid: oldOid },
      ABSENT_MODE.test(newMode) ? null : { mode: newMode, oid: newOid },
    ]);
  }
  return changes;
}

/** `git ls-tree -r -z` output → path → entry. */
function parseLsTree(out: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const line of out.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , oid] = line.slice(0, tab).split(' ');
    entries.set(line.slice(tab + 1), { mode, oid });
  }
  return entries;
}

/** `git ls-files -s -z` output → path → stage-0 entry (null when the path is conflicted). */
function parseIndex(out: string): Map<string, TreeEntry | null> {
  const entries = new Map<string, TreeEntry | null>();
  for (const line of out.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = line.slice(0, tab).split(' ');
    const file = line.slice(tab + 1);
    entries.set(file, stage === '0' && !entries.has(file) ? { mode, oid } : null);
  }
  return entries;
}

function sameEntry(a: TreeEntry | null | undefined, b: TreeEntry | null): boolean {
  if (a === null) return false; // conflicted in the shared index: never touch
  if (a === undefined) return b === null;
  return b !== null && a.mode === b.mode && a.oid === b.oid;
}

function gitOrThrow(cwd: string, args: string[]): string {
  const result = safeExecResult('git', args, { cwd, timeoutMs: 60_000, maxOutputMB: 256 });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || String(result.status)}`);
  }
  return result.stdout;
}

/**
 * After HEAD moved from `fromSha` (commits made through a private index),
 * move every shared-index entry the commits changed to the new HEAD — only
 * where the shared entry still equals `fromSha`'s, so work another session
 * staged there is never clobbered. The shared index is re-read right before
 * each write attempt, and a write refused because another git process holds
 * `index.lock` is retried on `retry.delaysMs`. Returns null when HEAD did not
 * move; throws when the write still fails.
 */
export function reconcileSharedIndex(
  repoRoot: string,
  fromSha: string | null,
  sessionId: string,
  retry: ReconcileRetryOptions = {}
): SharedIndexReconcileAudit | null {
  const head = gitText(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']) || null;
  if (!head || head === fromSha) return null;
  const changes = fromSha
    ? parseRawDiff(gitOrThrow(repoRoot, ['diff-tree', '-r', '-z', '--no-renames', fromSha, head]))
    : new Map(
        [...parseLsTree(gitOrThrow(repoRoot, ['ls-tree', '-r', '-z', head]))].map(
          ([file, entry]) => [file, [null, entry] as [TreeEntry | null, TreeEntry | null]]
        )
      );
  const delays = retry.delaysMs ?? INDEX_LOCK_RETRY_DELAYS_MS;
  const sleep = retry.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt += 1) {
    const shared = parseIndex(gitOrThrow(repoRoot, ['ls-files', '-s', '-z']));
    const updated: string[] = [];
    const skipped: string[] = [];
    let input = '';
    for (const [file, [before, after]] of changes) {
      if (!sameEntry(shared.get(file), before)) {
        skipped.push(file);
        continue;
      }
      const zero = '0'.repeat((after ?? before)?.oid.length ?? 40);
      input += after ? `${after.mode} ${after.oid}\t${file}\0` : `0 ${zero}\t${file}\0`;
      updated.push(file);
    }
    const done = {
      sessionId,
      fromSha,
      toSha: head,
      result: 'completed' as const,
      updated,
      skipped,
    };
    if (!input) return done;
    const written = safeExecResult('git', ['update-index', '-z', '--index-info'], {
      cwd: repoRoot,
      timeoutMs: 60_000,
      input,
    });
    if (written.status === 0) return done;
    const stderr = written.stderr.trim();
    if (!INDEX_LOCKED.test(stderr) || attempt >= delays.length) {
      throw new Error(`git update-index failed: ${stderr || String(written.status)}`);
    }
    sleep(delays[attempt]);
  }
}

function defaultReconcileAudit(entry: SharedIndexReconcileAudit): void {
  auditChain.record({
    agentId: 'session-git-index',
    action: 'shared_index_reconcile',
    operation: 'dispose',
    result: entry.result,
    reason:
      entry.result === 'completed'
        ? `HEAD moved from ${entry.fromSha ?? '(none)'} to ${entry.toSha ?? '(unknown)'} during session ${entry.sessionId}`
        : `shared index not reconciled after session ${entry.sessionId}: ${entry.error ?? 'unknown error'}`,
    metadata: { ...entry },
  });
}

export interface RunReconcileOptions {
  audit?: (entry: SharedIndexReconcileAudit) => void;
  retry?: ReconcileRetryOptions;
}

/**
 * One audited reconcile of the shared index from `fromSha`. `ok` is false
 * when it failed (audited with result `failed`); `sha` is the HEAD the
 * shared index now follows.
 */
export function runSharedIndexReconcile(
  repoRoot: string,
  fromSha: string | null,
  sessionId: string,
  options: RunReconcileOptions = {}
): { ok: boolean; sha: string | null } {
  const audit = options.audit ?? defaultReconcileAudit;
  const record = (entry: SharedIndexReconcileAudit) => {
    try {
      audit(entry);
    } catch (error) {
      logger.warn(`reconcile audit failed: ${errorText(error)}`);
    }
  };
  try {
    const result = reconcileSharedIndex(repoRoot, fromSha, sessionId, options.retry);
    if (!result) return { ok: true, sha: fromSha };
    logger.warn(
      `HEAD moved to ${result.toSha} during session ${sessionId}; shared index updated for ${result.updated.length} path(s), ${result.skipped.length} with other staged work left alone`
    );
    record(result);
    return { ok: true, sha: result.toSha };
  } catch (error) {
    logger.warn(`shared index reconcile failed for ${sessionId}: ${errorText(error)}`);
    record({
      sessionId,
      fromSha,
      toSha: null,
      result: 'failed',
      updated: [],
      skipped: [],
      error: errorText(error),
    });
    return { ok: false, sha: fromSha };
  }
}

/**
 * Complete the pending reconcile recorded on a git-index ledger entry (janitor
 * sweep / a later dispose). Returns true when nothing is pending any more.
 */
export function retryPendingSharedIndexReconcile(
  record: WorkspaceRecord,
  ledger: WorkspaceLedgerOptions = {},
  options: RunReconcileOptions = {}
): boolean {
  const pending = record.pendingReconcile;
  if (!pending) return true;
  const sessionId = record.owner.session_id ?? record.id;
  if (!runSharedIndexReconcile(pending.repoRoot, pending.fromSha, sessionId, options).ok) {
    return false;
  }
  annotateWorkspace(record.id, { pendingReconcile: null }, ledger);
  return true;
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
    const estimatedBytes = realIndexBytes(realIndex);
    const budget = checkWorkspaceBudget(dir, estimatedBytes, {
      ...ledger,
      ...options.budget,
    });
    if (!budget.allowed) {
      logger.warn(
        `workspace budget denied a private index for ${sessionId} (${budget.reason}); the session shares the real index`
      );
      return null;
    }

    const probe = options.processProbe ?? {};
    const pidStartedAt = (probe.startMarker ?? processStartMarker)(process.pid);
    const record = registerWorkspace(
      {
        path: dir,
        kind: 'git-index',
        owner: { ...(input.owner ?? {}), session_id: sessionId },
        bytes: estimatedBytes,
        pid: process.pid,
        ...(pidStartedAt ? { pidStartedAt } : {}),
      },
      ledger
    );
    workspaceId = record.id;
    safeMkdir(record.path, { recursive: true });
    const indexPath = path.join(record.path, 'index');
    const resolvedRoot = path.resolve(repoRoot);
    seedIndex(resolvedRoot, indexPath, baselineSha);

    const id = record.id;
    const reconcileOptions: RunReconcileOptions = {
      ...(options.audit ? { audit: options.audit } : {}),
      ...(options.reconcileRetry ? { retry: options.reconcileRetry } : {}),
    };
    const startMarker = probe.startMarker ?? processStartMarker;
    let reconciledSha = baselineSha;
    let pendingRecorded = false;
    let attachedChild: { childPid: number; childStartedAt?: string } | undefined;
    let released: WorkspaceRecord | null = null;
    let finished = false;

    const currentRecord = () => listWorkspaces(ledger).find((candidate) => candidate.id === id);
    const childOf = (pid: number) => {
      const childStartedAt = startMarker(pid);
      return { childPid: pid, ...(childStartedAt ? { childStartedAt } : {}) };
    };

    // Reconcile this session's commits; on failure keep it pending in the ledger.
    const reconcileOwn = (): boolean => {
      const outcome = runSharedIndexReconcile(
        resolvedRoot,
        reconciledSha,
        sessionId,
        reconcileOptions
      );
      reconciledSha = outcome.sha;
      if (outcome.ok) {
        if (pendingRecorded) {
          annotateWorkspace(id, { pendingReconcile: null }, ledger);
          pendingRecorded = false;
        }
        return true;
      }
      // An inherited pending reconcile starts from an older HEAD and covers ours.
      if (pendingRecorded || !currentRecord()?.pendingReconcile) {
        annotateWorkspace(
          id,
          { pendingReconcile: { repoRoot: resolvedRoot, fromSha: reconciledSha } },
          ledger
        );
        pendingRecorded = true;
      }
      return false;
    };

    // A reconcile left pending by an earlier occupant of this ledger entry.
    const settleInherited = (): boolean => {
      const current = currentRecord();
      return !current || retryPendingSharedIndexReconcile(current, ledger, reconcileOptions);
    };

    return {
      sessionId,
      repoRoot: resolvedRoot,
      indexPath,
      baselineSha,
      workspaceId: id,
      env: { GIT_INDEX_FILE: indexPath },
      attachChild: (pid) => {
        if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
        attachedChild = childOf(pid);
        try {
          annotateWorkspace(id, attachedChild, ledger);
        } catch (error) {
          logger.warn(`could not record child ${pid} of ${sessionId}: ${errorText(error)}`);
        }
      },
      dispose: (disposeOptions = {}) => {
        if (finished) return;
        try {
          const reconciled = reconcileOwn();
          if (!released) {
            released = releaseWorkspace(id, ledger, { bytes: realIndexBytes(indexPath) });
            if (!released) {
              finished = true;
              return;
            }
          }
          if (!reconciled || !settleInherited()) {
            logger.warn(
              `shared index reconcile pending for ${sessionId}; ${indexPath} kept for a later dispose or the janitor sweep`
            );
            return;
          }
          const child =
            disposeOptions.childPid === undefined ||
            disposeOptions.childPid === attachedChild?.childPid
              ? attachedChild
              : childOf(disposeOptions.childPid);
          if (child && isRecordedChildAlive(child, probe)) {
            if (child !== attachedChild) annotateWorkspace(id, child, ledger);
            logger.warn(
              `child ${child.childPid} of ${sessionId} may still use ${indexPath}; kept for the janitor sweep`
            );
            return;
          }
          finished = true;
          deleteRegisteredWorkspace(id, ledger, {
            expect: {
              live: released.live,
              createdAt: released.createdAt,
              releasedAt: released.releasedAt,
            },
          });
        } catch (error) {
          finished = true;
          logger.warn(
            `dispose failed for ${sessionId}; the janitor sweep reclaims it: ${errorText(error)}`
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
