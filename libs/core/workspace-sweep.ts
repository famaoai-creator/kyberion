/**
 * WS-07 ledger-driven workspace sweep (called by the storage janitor and the
 * `kyberion workspace gc` CLI). Kept apart from storage-janitor.ts so the
 * janitor stays a thin orchestrator of per-store sweeps.
 */

import * as nodePath from 'node:path';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import { findMissionPath, rootDir } from './path-resolver.js';
import { loadWorkspaceBudgetPolicy, measureWorkspaceBytes } from './workspace-budget.js';
import {
  annotateWorkspace,
  deleteRegisteredWorkspace,
  listUnregisteredWorkspaceDirs,
  listWorkspaces,
  type WorkspaceLedgerOptions,
  type WorkspaceOwner,
  type WorkspaceRecord,
} from './workspace-ledger.js';
import {
  isPidAlive,
  isProcessGroupAlive,
  isRecordedProcessAlive,
  type ProcessIdentityProbe,
} from './workspace-process-identity.js';

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
  /** Test seam: process liveness probes for pid-tracked git-index records. */
  processProbe?: ProcessIdentityProbe;
  /** Test seam: size probe used to refresh cached `bytes` of surviving records. */
  measure?: (targetPath: string) => number;
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
 * but its owner is terminal and `createdAt + TTL` has passed. A live git
 * index is an orphan once the process that registered it is gone (legacy
 * records without a pid: after the TTL); a git index whose delegated child
 * still runs is never an orphan. Orphans are deleted only through
 * `deleteRegisteredWorkspace`, which re-checks every path invariant and the
 * record snapshot under the ledger lock and keeps git worktrees with unsaved
 * work; directories without a ledger record are reported, never deleted.
 * Surviving records get their cached `bytes` refreshed. Dry-run reports
 * without touching disk or the ledger.
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
  const probe = opts.processProbe ?? {};
  const pidAlive = probe.isPidAlive ?? isPidAlive;
  const childAlive = (record: WorkspaceRecord): boolean =>
    record.childPid !== undefined &&
    (pidAlive(record.childPid) || (!probe.isPidAlive && isProcessGroupAlive(record.childPid)));
  const orphanReason = (record: WorkspaceRecord): string | null => {
    if (record.kind === 'git-index' && childAlive(record)) return null;
    if (!record.live) return expired(record.releasedAt) ? 'released past orphan TTL' : null;
    if (record.kind === 'git-index') {
      if (record.pid !== undefined) {
        return isRecordedProcessAlive(record.pid, record.pidStartedAt, probe)
          ? null
          : 'registering process exited';
      }
      return expired(record.createdAt) ? 'live git index without a process past orphan TTL' : null;
    }
    return expired(record.createdAt) && isOwnerTerminal(record.owner)
      ? 'owner terminal past orphan TTL'
      : null;
  };
  const reasons = new Map<string, string>();
  for (const record of records) {
    const reason = orphanReason(record);
    if (reason) reasons.set(record.id, reason);
  }
  const orphaned = records.filter((record) => reasons.has(record.id));

  const deleted: WorkspaceRecord[] = [];
  if (!opts.dryRun) {
    for (const record of orphaned) {
      try {
        const result = deleteRegisteredWorkspace(
          record.id,
          { ...ledger, now: () => new Date(nowMs) },
          {
            expect: {
              live: record.live,
              createdAt: record.createdAt,
              releasedAt: record.releasedAt,
            },
            requireCleanWorktree: true,
          }
        );
        deleted.push(record);
        opts.audit?.({
          event: 'WORKSPACE_DELETE',
          path: repoRelativePosix(record.path),
          workspace_id: record.id,
          kind: record.kind,
          owner: record.owner,
          removed_from_disk: result.removedFromDisk,
          reason: reasons.get(record.id),
        });
      } catch (err: unknown) {
        errors.push(`workspace ${record.id}: ${errorMessage(err)}`);
      }
    }
    const measure = opts.measure ?? ((target: string) => measureWorkspaceBytes(target));
    const deletedIds = new Set(deleted.map((record) => record.id));
    for (const record of records) {
      if (deletedIds.has(record.id)) continue;
      try {
        const bytes = measure(record.path);
        if (bytes !== record.bytes) annotateWorkspace(record.id, { bytes }, ledger);
      } catch (err: unknown) {
        errors.push(`bytes ${record.id}: ${errorMessage(err)}`);
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
