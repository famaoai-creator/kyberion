import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  DEFAULT_WORKSPACE_BUDGET_POLICY,
  checkWorkspaceBudget,
  loadWorkspaceBudgetPolicy,
  measureWorkspaceBytes,
  type WorkspaceBudgetOptions,
} from './workspace-budget.js';
import {
  annotateWorkspace,
  listWorkspaces,
  registerWorkspace,
  releaseWorkspace,
  type WorkspaceRecord,
} from './workspace-ledger.js';

let base: string;
let clock: number;
let options: WorkspaceBudgetOptions;

function workspaceWithBytes(name: string, bytes: number): WorkspaceRecord {
  const dir = path.join(base, 'workspaces', name);
  safeWriteFile(path.join(dir, 'blob.bin'), 'x'.repeat(bytes));
  return registerWorkspace({ path: dir, kind: 'scratch-dir', owner: {} }, options);
}

function released(name: string, bytes: number): WorkspaceRecord {
  const record = workspaceWithBytes(name, bytes);
  clock += 1000;
  return releaseWorkspace(record.id, options) as WorkspaceRecord;
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-ws-budget/${randomUUID()}`);
  clock = Date.parse('2026-09-26T00:00:00.000Z');
  options = {
    ledgerPath: path.join(base, 'workspaces', 'ledger.json'),
    allowedRoots: [path.join(base, 'workspaces')],
    now: () => new Date(clock),
    policy: { disk_cap_bytes: 1000, min_free_bytes: 0, orphan_ttl_hours: 24 },
    statfs: () => ({ freeBytes: 1_000_000 }),
  };
  safeMkdir(path.join(base, 'workspaces'), { recursive: true });
});

afterEach(() => {
  safeRmSync(base, { recursive: true, force: true });
});

describe('workspace-budget', () => {
  it('measures bytes without following symlinks', () => {
    const dir = path.join(base, 'workspaces', 'm');
    safeWriteFile(path.join(dir, 'a.txt'), '12345');
    safeWriteFile(path.join(dir, 'nested', 'b.txt'), '123');
    const outside = path.join(base, 'outside');
    safeWriteFile(path.join(outside, 'big.txt'), 'x'.repeat(500));
    safeSymlinkSync(outside, path.join(dir, 'link'), 'dir');
    expect(measureWorkspaceBytes(dir)).toBe(8);
    expect(measureWorkspaceBytes(path.join(dir, 'missing'))).toBe(0);
  });

  it('allows a workspace within the cap', () => {
    workspaceWithBytes('live', 100);
    const result = checkWorkspaceBudget(base, 100, options);
    expect(result).toEqual({ allowed: true, usedBytes: 100, freeBytes: 1_000_000, reclaimed: [] });
  });

  it('reclaims released workspaces oldest first when near the cap', () => {
    const oldest = released('old', 300);
    const newer = released('new', 300);
    workspaceWithBytes('live', 300);
    const result = checkWorkspaceBudget(base, 100, options);
    expect(result.allowed).toBe(true);
    expect(result.reclaimed).toEqual([oldest.id]);
    expect(result.usedBytes).toBe(600);
    expect(safeExistsSync(oldest.path)).toBe(false);
    expect(safeExistsSync(newer.path)).toBe(true);
    expect(listWorkspaces(options).map((r) => r.id)).not.toContain(oldest.id);
  });

  it('never reclaims live workspaces and denies when the cap is exceeded', () => {
    const live = workspaceWithBytes('live', 900);
    const result = checkWorkspaceBudget(base, 200, options);
    expect(result).toMatchObject({ allowed: false, reason: 'cap-exceeded', reclaimed: [] });
    expect(safeExistsSync(live.path)).toBe(true);
  });

  it('enforces the free-disk floor and reclaims released workspaces to meet it', () => {
    const old = released('old', 10);
    const result = checkWorkspaceBudget(base, 10, {
      ...options,
      policy: { disk_cap_bytes: 0, min_free_bytes: 100, orphan_ttl_hours: 24 },
      statfs: () => ({ freeBytes: safeExistsSync(old.path) ? 50 : 500 }),
    });
    expect(result.allowed).toBe(true);
    expect(result.reclaimed).toEqual([old.id]);

    const denied = checkWorkspaceBudget(base, 10, {
      ...options,
      policy: { disk_cap_bytes: 0, min_free_bytes: 100, orphan_ttl_hours: 24 },
      statfs: () => ({ freeBytes: 50 }),
    });
    expect(denied).toMatchObject({ allowed: false, reason: 'free-disk-floor', freeBytes: 50 });
  });

  it('fails closed when free space is unreadable and a floor is configured', () => {
    const unreadable = () => {
      throw new Error('statfs unavailable');
    };
    const denied = checkWorkspaceBudget(base, 0, {
      ...options,
      policy: { disk_cap_bytes: 0, min_free_bytes: 1, orphan_ttl_hours: 24 },
      statfs: unreadable,
    });
    expect(denied).toMatchObject({ allowed: false, reason: 'free-disk-floor', freeBytes: null });

    const noFloor = checkWorkspaceBudget(base, 0, {
      ...options,
      policy: { disk_cap_bytes: 0, min_free_bytes: 0, orphan_ttl_hours: 24 },
      statfs: unreadable,
    });
    expect(noFloor).toMatchObject({ allowed: true, freeBytes: null });
  });

  it('uses cached ledger bytes and measures only records without them', () => {
    const cachedDir = path.join(base, 'workspaces', 'cached');
    registerWorkspace({ path: cachedDir, kind: 'scratch-dir', owner: {}, bytes: 400 }, options);
    const measure = vi.fn(() => 0);
    const cached = checkWorkspaceBudget(base, 100, { ...options, measure });
    expect(measure).not.toHaveBeenCalled();
    expect(cached).toMatchObject({ allowed: true, usedBytes: 400 });

    const uncachedDir = path.join(base, 'workspaces', 'uncached');
    registerWorkspace({ path: uncachedDir, kind: 'scratch-dir', owner: {} }, options);
    measure.mockReturnValue(50);
    expect(checkWorkspaceBudget(base, 0, { ...options, measure }).usedBytes).toBe(450);
    expect(measure.mock.calls).toEqual([[uncachedDir]]);
  });

  it('bounds the measurement walk', () => {
    const dir = path.join(base, 'workspaces', 'many');
    for (let i = 0; i < 5; i += 1) safeWriteFile(path.join(dir, `f${i}.txt`), 'xx');
    expect(measureWorkspaceBytes(dir)).toBe(10);
    expect(measureWorkspaceBytes(dir, { maxEntries: 2 })).toBe(4);
    let t = 0;
    expect(measureWorkspaceBytes(dir, { maxMs: 0, clock: () => (t += 1) })).toBe(0);
  });

  it('skips a released workspace that cannot be deleted and reclaims the next one', () => {
    const broken = released('broken', 300);
    const next = released('next', 300);
    workspaceWithBytes('live', 300);
    const victim = path.join(base, 'victim');
    safeWriteFile(path.join(victim, 'keep.txt'), 'keep');
    safeRmSync(broken.path, { recursive: true, force: true });
    safeSymlinkSync(victim, broken.path, 'dir');
    // The broken entry measures 0 (symlink), so 600 + 350 crosses the 900 threshold.
    const result = checkWorkspaceBudget(base, 350, options);
    expect(result.reclaimed).toEqual([next.id]);
    expect(result.allowed).toBe(true);
    expect(safeExistsSync(path.join(victim, 'keep.txt'))).toBe(true);
  });

  it('never reclaims released git worktrees inline (left to the TTL sweep)', () => {
    const dir = path.join(base, 'workspaces', 'wt');
    safeWriteFile(path.join(dir, 'blob.bin'), 'x'.repeat(900));
    const worktree = registerWorkspace({ path: dir, kind: 'git-worktree', owner: {} }, options);
    releaseWorkspace(worktree.id, options);
    const result = checkWorkspaceBudget(base, 200, options);
    expect(result).toMatchObject({ allowed: false, reason: 'cap-exceeded', reclaimed: [] });
    expect(safeExistsSync(dir)).toBe(true);
  });

  it('never reclaims a released git index whose delegated child still runs', () => {
    const gitIndex = (name: string, child: { childPid: number; childStartedAt: string }) => {
      const dir = path.join(base, 'workspaces', name);
      safeWriteFile(path.join(dir, 'index'), 'x'.repeat(300));
      const record = registerWorkspace({ path: dir, kind: 'git-index', owner: {} }, options);
      clock += 1000;
      releaseWorkspace(record.id, options);
      annotateWorkspace(record.id, child, options);
      return record;
    };
    const running = gitIndex('running', { childPid: 501, childStartedAt: 'child-501' });
    const exited = gitIndex('exited', { childPid: 502, childStartedAt: 'child-502' });
    const recycled = gitIndex('recycled', { childPid: 503, childStartedAt: 'child-503' });
    const result = checkWorkspaceBudget(base, 800, {
      ...options,
      processProbe: {
        isPidAlive: (pid) => pid !== 502,
        startMarker: (pid) => (pid === 503 ? 'someone-else' : `child-${pid}`),
      },
    });
    expect(result.reclaimed).toEqual([exited.id, recycled.id]);
    expect(safeExistsSync(running.path)).toBe(true);
    expect(listWorkspaces(options).map((record) => record.id)).toEqual([running.id]);
  });

  it('never reclaims a git index whose shared-index reconcile is pending', () => {
    const dir = path.join(base, 'workspaces', 'pending');
    safeWriteFile(path.join(dir, 'index'), 'x'.repeat(900));
    const record = registerWorkspace({ path: dir, kind: 'git-index', owner: {} }, options);
    releaseWorkspace(record.id, options);
    annotateWorkspace(record.id, { pendingReconcile: { repoRoot: base, fromSha: null } }, options);
    const result = checkWorkspaceBudget(base, 200, options);
    expect(result).toMatchObject({ allowed: false, reason: 'cap-exceeded', reclaimed: [] });
    expect(safeExistsSync(dir)).toBe(true);
  });

  it('loads the governed policy and applies env overrides', () => {
    expect(loadWorkspaceBudgetPolicy({})).toEqual(DEFAULT_WORKSPACE_BUDGET_POLICY);
    expect(
      loadWorkspaceBudgetPolicy({
        KYBERION_WORKSPACE_DISK_CAP_BYTES: '5000',
        KYBERION_WORKSPACE_MIN_FREE_BYTES: 'not-a-number',
        KYBERION_WORKSPACE_ORPHAN_TTL_HOURS: '2',
      })
    ).toEqual({
      disk_cap_bytes: 5000,
      min_free_bytes: DEFAULT_WORKSPACE_BUDGET_POLICY.min_free_bytes,
      orphan_ttl_hours: 2,
    });
  });
});
