/**
 * WS-07 ledger-driven workspace sweep (called by the storage janitor and the
 * `kyberion workspace gc` CLI). Kept apart from storage-janitor.ts so the
 * janitor stays a thin orchestrator of per-store sweeps.
 */

import * as nodePath from 'node:path';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import { findMissionPath, rootDir } from './path-resolver.js';
import { loadWorkspaceBudgetPolicy } from './workspace-budget.js';
import {
  deleteRegisteredWorkspace,
  listUnregisteredWorkspaceDirs,
  listWorkspaces,
  type WorkspaceLedgerOptions,
  type WorkspaceOwner,
  type WorkspaceRecord,
} from './workspace-ledger.js';

export interface SweepWorkspacesOptions extends Omit<WorkspaceLedgerOptions, 'now'> {
  dryRun: boolean;
  now?: () => number;
  /** Orphan TTL override; defaults to the workspace budget policy. */
  orphanTtlHours?: number;
  /**
   * Whether the owning mission/session has reached a terminal state. The
   * default resolves `owner.mission_id` through mission state; session-only
   * owners are never treated as terminal (conservative).
   */
  isOwnerTerminal?: (owner: WorkspaceOwner) => boolean;
  /** Deletion audit sink (the janitor wires its retention audit log here). */
  audit?: (record: Record<string, unknown>) => void;
}

export interface SweepWorkspacesResult {
  registered: number;
  orphaned: WorkspaceRecord[];
  deleted: WorkspaceRecord[];
  /** Repo-relative directories under the workspace roots with no ledger record (never deleted). */
  unregisteredDirs: string[];
  errors: string[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function repoRelativePosix(absolutePath: string): string {
  return nodePath.relative(rootDir(), absolutePath).split(nodePath.sep).join('/');
}

const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'archived']);

function missionOwnerTerminal(owner: WorkspaceOwner): boolean {
  if (!owner.mission_id) return false;
  try {
    const missionPath = findMissionPath(owner.mission_id);
    if (!missionPath) return false;
    const state = loadMissionStateAtPath(nodePath.join(missionPath, 'mission-state.json'));
    return state ? TERMINAL_MISSION_STATUSES.has(state.status) : false;
  } catch {
    return false;
  }
}

/**
 * WS-07 workspace sweep. A registered workspace is an orphan when it was
 * released and `releasedAt + TTL` has passed, or when it is still marked live
 * but its owner is terminal and `createdAt + TTL` has passed. Orphans are
 * deleted only through `deleteRegisteredWorkspace` (which re-checks every
 * path invariant); directories without a ledger record are reported, never
 * deleted. Dry-run reports without touching disk or the ledger.
 */
export function sweepRegisteredWorkspaces(opts: SweepWorkspacesOptions): SweepWorkspacesResult {
  const now = opts.now ?? Date.now;
  const isOwnerTerminal = opts.isOwnerTerminal ?? missionOwnerTerminal;
  const ledger: WorkspaceLedgerOptions = {
    ledgerPath: opts.ledgerPath,
    allowedRoots: opts.allowedRoots,
  };
  const errors: string[] = [];
  const empty = (): SweepWorkspacesResult => ({
    registered: 0,
    orphaned: [],
    deleted: [],
    unregisteredDirs: [],
    errors,
  });

  let records: WorkspaceRecord[];
  try {
    records = listWorkspaces(ledger);
  } catch (err: unknown) {
    errors.push(`read: ${errorMessage(err)}`);
    return empty();
  }

  let ttlHours = opts.orphanTtlHours;
  if (ttlHours === undefined) {
    try {
      ttlHours = loadWorkspaceBudgetPolicy().orphan_ttl_hours;
    } catch (err: unknown) {
      errors.push(`policy: ${errorMessage(err)}`);
      return { ...empty(), registered: records.length };
    }
  }
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const nowMs = now();
  const expired = (iso: string | undefined): boolean => {
    const ts = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ts) && ts + ttlMs <= nowMs;
  };
  const orphaned = records.filter((record) =>
    record.live
      ? expired(record.createdAt) && isOwnerTerminal(record.owner)
      : expired(record.releasedAt)
  );

  const deleted: WorkspaceRecord[] = [];
  if (!opts.dryRun) {
    for (const record of orphaned) {
      try {
        const result = deleteRegisteredWorkspace(record.id, {
          ...ledger,
          now: () => new Date(nowMs),
        });
        deleted.push(record);
        opts.audit?.({
          event: 'WORKSPACE_DELETE',
          path: repoRelativePosix(record.path),
          workspace_id: record.id,
          kind: record.kind,
          owner: record.owner,
          removed_from_disk: result.removedFromDisk,
          reason: record.live ? 'owner terminal past orphan TTL' : 'released past orphan TTL',
        });
      } catch (err: unknown) {
        errors.push(`workspace ${record.id}: ${errorMessage(err)}`);
      }
    }
  }

  let unregisteredDirs: string[] = [];
  try {
    unregisteredDirs = listUnregisteredWorkspaceDirs(ledger).map(repoRelativePosix);
  } catch (err: unknown) {
    errors.push(`unregistered: ${errorMessage(err)}`);
  }

  return { registered: records.length, orphaned, deleted, unregisteredDirs, errors };
}
