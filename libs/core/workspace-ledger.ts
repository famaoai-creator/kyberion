/**
 * WS-05 workspace ledger.
 *
 * Every per-session workspace (git worktree, scratch directory, private git
 * index) is recorded here before use. The ledger is the only source of
 * ownership: sweeps and budget reclaim delete exclusively paths recorded
 * here, never paths inferred from a directory layout.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { knowledge, rootDir, shared } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { withLockSync } from './src/lock-utils.js';

export type WorkspaceKind = 'git-worktree' | 'scratch-dir' | 'git-index';

export interface WorkspaceOwner {
  mission_id?: string;
  task_id?: string;
  session_id?: string;
}

export interface WorkspaceRecord {
  id: string;
  /** Absolute, symlink-free repository path; the ledger key. */
  path: string;
  kind: WorkspaceKind;
  owner: WorkspaceOwner;
  /** git-worktree only: repository the worktree belongs to (defaults to the Kyberion root). */
  repoRoot?: string;
  createdAt: string;
  live: boolean;
  releasedAt?: string;
  bytes?: number;
}

export interface RegisterWorkspaceInput {
  path: string;
  kind: WorkspaceKind;
  owner: WorkspaceOwner;
  repoRoot?: string;
  bytes?: number;
}

export interface WorkspaceLedgerOptions {
  /** Test seam: ledger file location (defaults to active/shared/runtime/workspaces/ledger.json). */
  ledgerPath?: string;
  /** Test seam: directories under which registered workspaces may live. */
  allowedRoots?: string[];
  now?: () => Date;
}

export interface DeleteWorkspaceResult {
  record: WorkspaceRecord;
  /** false when the path was already gone; the record is dropped either way. */
  removedFromDisk: boolean;
  deletedAt: string;
}

export const WORKSPACE_LEDGER_SUBPATH = 'runtime/workspaces/ledger.json';
export const WORKSPACES_ROOT_SUBPATH = 'runtime/workspaces';
export const GIT_INDEXES_ROOT_SUBPATH = 'runtime/git-indexes';
export const WORKTREES_ROOT_REPO_PATH = '.worktrees';

const WORKSPACE_LEDGER_SCHEMA_PATH = knowledge('product/schemas/workspace-ledger.schema.json');

function workspaceLedgerCatalog(filePath: string) {
  return defineCatalog<WorkspaceRecord[]>({
    id: 'workspace-ledger',
    path: filePath,
    schema: WORKSPACE_LEDGER_SCHEMA_PATH,
  });
}

/** Directory under which ledger-allocated scratch workspaces are materialised. */
export function workspacesRootDir(): string {
  return shared(WORKSPACES_ROOT_SUBPATH);
}

/** The only directories a registered workspace may live under. */
export function defaultWorkspaceRoots(): string[] {
  return [
    shared(WORKSPACES_ROOT_SUBPATH),
    path.join(rootDir(), WORKTREES_ROOT_REPO_PATH),
    shared(GIT_INDEXES_ROOT_SUBPATH),
  ];
}

function ledgerPathOf(options: WorkspaceLedgerOptions): string {
  return assertSafeRepositoryPath(options.ledgerPath ?? shared(WORKSPACE_LEDGER_SUBPATH), {
    allowMissingLeaf: true,
  });
}

function rootsOf(options: WorkspaceLedgerOptions): string[] {
  return (options.allowedRoots ?? defaultWorkspaceRoots()).map((root) => path.resolve(root));
}

function nowIsoOf(options: WorkspaceLedgerOptions): string {
  return (options.now ? options.now() : new Date()).toISOString();
}

function lockIdOf(ledgerPath: string): string {
  return `workspace-ledger-${createHash('sha256').update(ledgerPath, 'utf8').digest('hex')}`;
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Canonicalise a workspace path and enforce the location invariants: inside
 * the repository, no symlink anywhere on the path (including the leaf),
 * strictly below one of the allowed roots, and never the ledger file itself.
 */
function resolveWorkspacePath(rawPath: string, options: WorkspaceLedgerOptions): string {
  const resolved = assertSafeRepositoryPath(rawPath, { allowMissingLeaf: true });
  if (resolved === ledgerPathOf(options)) {
    throw new Error(`[WORKSPACE_PATH] the ledger file cannot be a workspace: ${rawPath}`);
  }
  if (!rootsOf(options).some((root) => isStrictlyInside(root, resolved))) {
    throw new Error(`[WORKSPACE_PATH] workspace path is outside the allowed roots: ${rawPath}`);
  }
  return resolved;
}

function readLedger(options: WorkspaceLedgerOptions): WorkspaceRecord[] {
  const filePath = ledgerPathOf(options);
  if (!safeExistsSync(filePath)) return [];
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[WORKSPACE_LEDGER_INVALID] ledger must be a regular file: ${filePath}`);
  }
  return workspaceLedgerCatalog(filePath).load();
}

function writeLedger(records: WorkspaceRecord[], options: WorkspaceLedgerOptions): void {
  const filePath = ledgerPathOf(options);
  const validated = workspaceLedgerCatalog(filePath).validate(records, filePath);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2), { encoding: 'utf8' });
}

function mutateLedger<T>(
  options: WorkspaceLedgerOptions,
  fn: (records: WorkspaceRecord[]) => { records: WorkspaceRecord[] | null; result: T }
): T {
  return withLockSync(lockIdOf(ledgerPathOf(options)), () => {
    const { records, result } = fn(readLedger(options));
    if (records) writeLedger(records, options);
    return result;
  });
}

function newWorkspaceId(): string {
  return `ws-${randomUUID()}`;
}

function cleanOwner(owner: WorkspaceOwner): WorkspaceOwner {
  const cleaned: WorkspaceOwner = {};
  if (owner.mission_id) cleaned.mission_id = owner.mission_id;
  if (owner.task_id) cleaned.task_id = owner.task_id;
  if (owner.session_id) cleaned.session_id = owner.session_id;
  return cleaned;
}

function registerWithId(
  id: string,
  input: RegisterWorkspaceInput,
  options: WorkspaceLedgerOptions
): WorkspaceRecord {
  const resolved = resolveWorkspacePath(input.path, options);
  const repoRoot =
    input.kind === 'git-worktree' && input.repoRoot
      ? assertSafeRepositoryPath(input.repoRoot)
      : undefined;
  return mutateLedger(options, (records) => {
    const existing = records.find((record) => record.path === resolved);
    if (existing) {
      if (existing.kind !== input.kind) {
        throw new Error(
          `[WORKSPACE_KIND_CONFLICT] ${resolved} is already registered as ${existing.kind}`
        );
      }
      // Re-registration reactivates the same ledger entry for the new owner.
      const reactivated: WorkspaceRecord = {
        ...existing,
        owner: cleanOwner(input.owner),
        live: true,
        ...(repoRoot ? { repoRoot } : {}),
        ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      };
      delete reactivated.releasedAt;
      return {
        records: records.map((record) => (record.id === existing.id ? reactivated : record)),
        result: reactivated,
      };
    }
    const record: WorkspaceRecord = {
      id,
      path: resolved,
      kind: input.kind,
      owner: cleanOwner(input.owner),
      ...(repoRoot ? { repoRoot } : {}),
      createdAt: nowIsoOf(options),
      live: true,
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    };
    return { records: [...records, record], result: record };
  });
}

/** Record a workspace path as owned. Idempotent per path (re-registering reactivates it). */
export function registerWorkspace(
  input: RegisterWorkspaceInput,
  options: WorkspaceLedgerOptions = {}
): WorkspaceRecord {
  return registerWithId(newWorkspaceId(), input, options);
}

/**
 * Allocate and register a fresh scratch directory at
 * `active/shared/runtime/workspaces/<id>/` (never under shared tmp, whose
 * generic TTL sweep would delete a workspace still in use).
 */
export function createScratchWorkspace(
  owner: WorkspaceOwner,
  options: WorkspaceLedgerOptions & { root?: string } = {}
): WorkspaceRecord {
  const id = newWorkspaceId();
  const dir = path.join(options.root ?? workspacesRootDir(), id);
  const record = registerWithId(id, { path: dir, kind: 'scratch-dir', owner }, options);
  safeMkdir(record.path, { recursive: true });
  return record;
}

/** Mark a workspace as no longer in use; it becomes eligible for reclaim. */
export function releaseWorkspace(
  id: string,
  options: WorkspaceLedgerOptions = {}
): WorkspaceRecord | null {
  return mutateLedger(options, (records) => {
    const existing = records.find((record) => record.id === id);
    if (!existing) return { records: null, result: null };
    if (!existing.live) return { records: null, result: existing };
    const released: WorkspaceRecord = { ...existing, live: false, releasedAt: nowIsoOf(options) };
    return {
      records: records.map((record) => (record.id === id ? released : record)),
      result: released,
    };
  });
}

export function listWorkspaces(options: WorkspaceLedgerOptions = {}): WorkspaceRecord[] {
  return readLedger(options);
}

/** Delegated worker CLIs run with KYBERION_DELEGATION_DEPTH >= 1; the owner path is depth 0. */
function isOwnerPath(): boolean {
  const depth = Number(getRegisteredEnvText('KYBERION_DELEGATION_DEPTH'));
  return !(Number.isFinite(depth) && depth > 0);
}

function removeWorkspaceFromDisk(record: WorkspaceRecord, resolved: string): boolean {
  if (!safeExistsSync(resolved)) return false;
  if (safeLstat(resolved).isSymbolicLink()) {
    throw new Error(`[WORKSPACE_SYMLINK] refusing to delete a symbolic link: ${resolved}`);
  }
  if (record.kind === 'git-worktree') {
    if (!isOwnerPath()) {
      throw new Error(
        `[WORKSPACE_OWNER_ONLY] git worktrees are removed only by the mission owner: ${resolved}`
      );
    }
    const result = safeExecResult('git', ['worktree', 'remove', '--force', resolved], {
      cwd: record.repoRoot ?? rootDir(),
      timeoutMs: 60_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `[WORKSPACE_GIT_WORKTREE] git worktree remove failed for ${resolved}: ${result.stderr.trim() || result.error?.message || `exit ${String(result.status)}`}`
      );
    }
    return true;
  }
  safeRmSync(resolved, { recursive: true, force: true });
  return true;
}

/**
 * Delete a registered workspace from disk and drop its ledger record.
 * Re-validates every location invariant at deletion time; git worktrees go
 * through `git worktree remove --force` on the owner path only, never rm.
 */
export function deleteRegisteredWorkspace(
  id: string,
  options: WorkspaceLedgerOptions = {}
): DeleteWorkspaceResult {
  return mutateLedger(options, (records) => {
    const record = records.find((candidate) => candidate.id === id);
    if (!record) throw new Error(`[WORKSPACE_NOT_REGISTERED] no workspace with id ${id}`);
    const resolved = resolveWorkspacePath(record.path, options);
    if (resolved !== record.path) {
      throw new Error(`[WORKSPACE_PATH] ledger path is not canonical: ${record.path}`);
    }
    const removedFromDisk = removeWorkspaceFromDisk(record, resolved);
    return {
      records: records.filter((candidate) => candidate.id !== id),
      result: { record, removedFromDisk, deletedAt: nowIsoOf(options) },
    };
  });
}

/**
 * Directories directly under the allowed roots that no ledger record covers.
 * Reported only — unregistered paths are never deleted.
 */
export function listUnregisteredWorkspaceDirs(options: WorkspaceLedgerOptions = {}): string[] {
  const records = readLedger(options);
  const ledgerPath = ledgerPathOf(options);
  const unregistered: string[] = [];
  for (const root of rootsOf(options)) {
    if (!safeExistsSync(root)) continue;
    let names: string[];
    try {
      names = safeReaddir(root);
    } catch {
      continue;
    }
    for (const name of [...names].sort()) {
      const candidate = path.join(root, name);
      if (candidate === ledgerPath) continue;
      try {
        if (!safeLstat(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      const covered = records.some(
        (record) => record.path === candidate || isStrictlyInside(candidate, record.path)
      );
      if (!covered) unregistered.push(candidate);
    }
  }
  return unregistered;
}
