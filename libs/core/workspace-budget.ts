/**
 * WS-06 workspace disk budget.
 *
 * Bounds the total size of ledger-registered workspaces and keeps a free-disk
 * floor on the target volume. When a new workspace would push usage near the
 * cap (or below the floor), released workspaces are reclaimed oldest first —
 * only through the ledger, never by inferring ownership from paths.
 */

import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { knowledge } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReaddir, safeStatfs } from './secure-io.js';
import {
  deleteRegisteredWorkspace,
  listWorkspaces,
  type WorkspaceLedgerOptions,
  type WorkspaceRecord,
} from './workspace-ledger.js';

export interface WorkspaceBudgetPolicy {
  /** Total bytes allowed across registered workspaces; 0 disables the cap. */
  disk_cap_bytes: number;
  /** Free bytes that must remain on the target volume; 0 disables the floor. */
  min_free_bytes: number;
  /** Hours a released / owner-terminal workspace is kept before the janitor sweep. */
  orphan_ttl_hours: number;
}

/** Documented defaults; the shipped workspace-budget-policy.json mirrors these. */
export const DEFAULT_WORKSPACE_BUDGET_POLICY: WorkspaceBudgetPolicy = {
  disk_cap_bytes: 20 * 1024 ** 3,
  min_free_bytes: 2 * 1024 ** 3,
  orphan_ttl_hours: 24,
};

/** Reclaim released workspaces once projected usage crosses this share of the cap. */
export const WORKSPACE_RECLAIM_THRESHOLD = 0.9;

const WORKSPACE_BUDGET_POLICY_PATH = knowledge('product/governance/workspace-budget-policy.json');
const WORKSPACE_BUDGET_POLICY_SCHEMA_PATH = knowledge(
  'product/schemas/workspace-budget-policy.schema.json'
);

const workspaceBudgetPolicyCatalog = defineCatalog<WorkspaceBudgetPolicy>({
  id: 'workspace-budget-policy',
  path: WORKSPACE_BUDGET_POLICY_PATH,
  schema: WORKSPACE_BUDGET_POLICY_SCHEMA_PATH,
});

function envNumber(name: string, env?: Record<string, string | undefined>): number | undefined {
  const raw = getRegisteredEnvText(name, env ? { env } : {});
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Governed policy JSON with KYBERION_WORKSPACE_* env overrides. */
export function loadWorkspaceBudgetPolicy(
  env?: Record<string, string | undefined>
): WorkspaceBudgetPolicy {
  const catalog = workspaceBudgetPolicyCatalog.load();
  const base: WorkspaceBudgetPolicy = {
    disk_cap_bytes: catalog.disk_cap_bytes,
    min_free_bytes: catalog.min_free_bytes,
    orphan_ttl_hours: catalog.orphan_ttl_hours,
  };
  return {
    disk_cap_bytes: envNumber('KYBERION_WORKSPACE_DISK_CAP_BYTES', env) ?? base.disk_cap_bytes,
    min_free_bytes: envNumber('KYBERION_WORKSPACE_MIN_FREE_BYTES', env) ?? base.min_free_bytes,
    orphan_ttl_hours:
      envNumber('KYBERION_WORKSPACE_ORPHAN_TTL_HOURS', env) ?? base.orphan_ttl_hours,
  };
}

export interface MeasureWorkspaceLimits {
  /** Stop after visiting this many entries (the result is then a lower bound). */
  maxEntries?: number;
  /** Stop after this many milliseconds (the result is then a lower bound). */
  maxMs?: number;
  clock?: () => number;
}

export const DEFAULT_MEASURE_MAX_ENTRIES = 200_000;
export const DEFAULT_MEASURE_MAX_MS = 5_000;

/**
 * Size of a path in bytes, never following symbolic links. Missing paths
 * count as 0. The walk is bounded by entry count and wall time so a huge tree
 * (node_modules) cannot stall a spawn; a bounded result is a lower bound.
 */
export function measureWorkspaceBytes(
  targetPath: string,
  limits: MeasureWorkspaceLimits = {}
): number {
  const maxEntries = limits.maxEntries ?? DEFAULT_MEASURE_MAX_ENTRIES;
  const maxMs = limits.maxMs ?? DEFAULT_MEASURE_MAX_MS;
  const clock = limits.clock ?? Date.now;
  const deadline = clock() + maxMs;
  let visited = 0;
  let stat;
  try {
    stat = safeLstat(targetPath);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  const pending = [targetPath];
  while (pending.length > 0) {
    if (visited >= maxEntries || clock() > deadline) break;
    const dir = pending.pop() as string;
    let names: string[];
    try {
      names = safeReaddir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (visited >= maxEntries) break;
      visited += 1;
      const child = path.join(dir, name);
      try {
        const childStat = safeLstat(child);
        if (childStat.isSymbolicLink()) continue;
        if (childStat.isDirectory()) pending.push(child);
        else if (childStat.isFile()) total += childStat.size;
      } catch {
        // vanished mid-walk
      }
    }
  }
  return total;
}

export type WorkspaceBudgetDenial = 'cap-exceeded' | 'free-disk-floor';

export interface WorkspaceBudgetResult {
  allowed: boolean;
  reason?: WorkspaceBudgetDenial;
  /** Bytes used by registered workspaces after any reclaim. */
  usedBytes: number;
  /** Free bytes on the target volume; null when it could not be read. */
  freeBytes: number | null;
  /** Ledger ids of released workspaces deleted to make room. */
  reclaimed: string[];
}

export interface WorkspaceBudgetOptions extends WorkspaceLedgerOptions {
  policy?: WorkspaceBudgetPolicy;
  /** Test seam for the free-space probe. */
  statfs?: (targetPath: string) => { freeBytes: number };
  measure?: (targetPath: string) => number;
}

function nearestExistingDir(targetDir: string): string {
  let current = path.resolve(targetDir);
  while (!safeExistsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Released workspaces eligible for inline reclaim, oldest first. Git
 * worktrees are left to the janitor sweep, which honours the orphan TTL and
 * refuses worktrees with unsaved work.
 */
function releasedOldestFirst(records: WorkspaceRecord[]): WorkspaceRecord[] {
  const key = (record: WorkspaceRecord) => Date.parse(record.releasedAt ?? record.createdAt) || 0;
  return records
    .filter((record) => !record.live && record.kind !== 'git-worktree')
    .sort((a, b) => key(a) - key(b));
}

/**
 * Decide whether a workspace of `expectedBytes` may be created in `targetDir`.
 * Fails closed when a free-disk floor is configured but free space is unreadable.
 * Uses each record's cached `bytes`; only records without one are measured.
 */
export function checkWorkspaceBudget(
  targetDir: string,
  expectedBytes = 0,
  options: WorkspaceBudgetOptions = {}
): WorkspaceBudgetResult {
  const policy = options.policy ?? loadWorkspaceBudgetPolicy();
  const measure = options.measure ?? measureWorkspaceBytes;
  const statfs = options.statfs ?? safeStatfs;
  const records = listWorkspaces(options);
  const sizes = new Map(
    records.map((record) => [record.id, record.bytes ?? measure(record.path)] as const)
  );
  let usedBytes = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  const reclaimable = releasedOldestFirst(records);
  const reclaimed: string[] = [];

  // One record that vanished, changed or refuses deletion never aborts the check.
  const reclaimOne = (): boolean => {
    for (let next = reclaimable.shift(); next; next = reclaimable.shift()) {
      try {
        deleteRegisteredWorkspace(next.id, options, {
          expect: { live: next.live, createdAt: next.createdAt, releasedAt: next.releasedAt },
        });
      } catch {
        continue;
      }
      usedBytes -= sizes.get(next.id) ?? 0;
      reclaimed.push(next.id);
      return true;
    }
    return false;
  };

  const cap = policy.disk_cap_bytes;
  if (cap > 0) {
    while (usedBytes + expectedBytes > cap * WORKSPACE_RECLAIM_THRESHOLD && reclaimOne()) {
      // reclaim until back under the threshold or nothing released remains
    }
    if (usedBytes + expectedBytes > cap) {
      return { allowed: false, reason: 'cap-exceeded', usedBytes, freeBytes: null, reclaimed };
    }
  }

  const readFree = (): number | null => {
    try {
      const free = statfs(nearestExistingDir(targetDir)).freeBytes;
      return Number.isFinite(free) ? free : null;
    } catch {
      return null;
    }
  };

  let freeBytes = readFree();
  const floor = policy.min_free_bytes;
  if (floor > 0) {
    while (freeBytes !== null && freeBytes - expectedBytes < floor && reclaimOne()) {
      freeBytes = readFree();
    }
    if (freeBytes === null || freeBytes - expectedBytes < floor) {
      return { allowed: false, reason: 'free-disk-floor', usedBytes, freeBytes, reclaimed };
    }
  }

  return { allowed: true, usedBytes, freeBytes, reclaimed };
}
