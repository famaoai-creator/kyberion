import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  annotateWorkspace,
  listWorkspaces,
  registerWorkspace,
  releaseWorkspace,
  type WorkspaceLedgerOptions,
  type WorkspaceRecord,
} from './workspace-ledger.js';
import { sweepRegisteredWorkspaces, type SweepWorkspacesOptions } from './workspace-sweep.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-09-26T00:00:00.000Z');

let base: string;
let clock: number;
let ledger: WorkspaceLedgerOptions;

function sweepOptions(overrides: Partial<SweepWorkspacesOptions> = {}): SweepWorkspacesOptions {
  return {
    dryRun: false,
    ledgerPath: ledger.ledgerPath,
    allowedRoots: ledger.allowedRoots,
    now: () => clock,
    orphanTtlHours: 24,
    isOwnerTerminal: () => false,
    processProbe: { isPidAlive: () => false, startMarker: () => undefined },
    measure: () => 0,
    ...overrides,
  };
}

function gitIndex(name: string, extra: Partial<Parameters<typeof registerWorkspace>[0]> = {}) {
  const dir = path.join(base, 'git-indexes', name);
  safeWriteFile(path.join(dir, 'index'), 'idx');
  return registerWorkspace(
    { path: dir, kind: 'git-index', owner: { session_id: name }, ...extra },
    ledger
  );
}

function git(cwd: string, args: string[]): string {
  const result = safeExecResult('git', args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-ws/${randomUUID()}`);
  clock = T0;
  ledger = {
    ledgerPath: path.join(base, 'workspaces', 'ledger.json'),
    allowedRoots: [
      path.join(base, 'workspaces'),
      path.join(base, 'git-indexes'),
      path.join(base, 'worktrees'),
    ],
    now: () => new Date(clock),
  };
  safeMkdir(path.join(base, 'workspaces'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  safeRmSync(base, { recursive: true, force: true });
});

describe('sweepRegisteredWorkspaces', () => {
  it('reclaims a live git index whose registering process is gone or was recycled', () => {
    const dead = gitIndex('dead', { pid: 101, pidStartedAt: 'start-101' });
    const recycled = gitIndex('recycled', { pid: 102, pidStartedAt: 'start-102' });
    const running = gitIndex('running', { pid: 103, pidStartedAt: 'start-103' });
    const legacyYoung = gitIndex('legacy-young');
    const result = sweepRegisteredWorkspaces(
      sweepOptions({
        processProbe: {
          isPidAlive: (pid) => pid !== 101,
          startMarker: (pid) => (pid === 102 ? 'someone-else' : `start-${pid}`),
        },
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.deleted.map((r) => r.id).sort()).toEqual([dead.id, recycled.id].sort());
    expect(safeExistsSync(dead.path)).toBe(false);
    expect(safeExistsSync(running.path)).toBe(true);
    expect(safeExistsSync(legacyYoung.path)).toBe(true);

    // A pid-less (legacy) live git index falls back to the orphan TTL.
    clock = T0 + 25 * HOUR;
    const later = sweepRegisteredWorkspaces(
      sweepOptions({ processProbe: { isPidAlive: () => true, startMarker: (p) => `start-${p}` } })
    );
    expect(later.deleted.map((r) => r.id)).toEqual([legacyYoung.id]);
    expect(listWorkspaces(ledger).map((r) => r.id)).toEqual([running.id]);
  });

  it('never reclaims a git index while its delegated child still runs', () => {
    const idx = gitIndex('child', { pid: 201 });
    releaseWorkspace(idx.id, ledger);
    const record = listWorkspaces(ledger)[0];
    safeWriteFile(
      ledger.ledgerPath!,
      JSON.stringify([{ ...record, childPid: 202 } satisfies WorkspaceRecord])
    );
    clock = T0 + 48 * HOUR;
    const kept = sweepRegisteredWorkspaces(
      sweepOptions({ processProbe: { isPidAlive: (pid) => pid === 202 } })
    );
    expect(kept.orphaned).toEqual([]);
    expect(safeExistsSync(idx.path)).toBe(true);

    const reclaimed = sweepRegisteredWorkspaces(sweepOptions());
    expect(reclaimed.deleted.map((r) => r.id)).toEqual([idx.id]);
  });

  it('reclaims a git index whose recorded child pid now belongs to another process', () => {
    const idx = gitIndex('child-recycled', { pid: 301 });
    releaseWorkspace(idx.id, ledger);
    annotateWorkspace(idx.id, { childPid: 302, childStartedAt: 'child-302' }, ledger);
    clock = T0 + 48 * HOUR;
    const alive = (marker: string) =>
      sweepRegisteredWorkspaces(
        sweepOptions({
          dryRun: true,
          processProbe: { isPidAlive: (pid) => pid === 302, startMarker: () => marker },
        })
      );
    expect(alive('child-302').orphaned).toEqual([]);
    expect(alive('someone-else').orphaned.map((r) => r.id)).toEqual([idx.id]);
  });

  it('abandons a pending reconcile whose base commit no longer resolves and reclaims the git index', () => {
    const idx = gitIndex('unresolvable');
    releaseWorkspace(idx.id, ledger);
    // `base` is not a git repository, so this fromSha can never resolve —
    // abandoned immediately, even though it is otherwise past the orphan TTL.
    annotateWorkspace(
      idx.id,
      { pendingReconcile: { repoRoot: base, fromSha: '0'.repeat(40) } },
      ledger
    );
    clock = T0 + 25 * HOUR;
    const audit = vi.fn();
    const result = sweepRegisteredWorkspaces(sweepOptions({ reconcile: { audit } }));
    expect(result.errors).toEqual([]);
    expect(result.deleted.map((r) => r.id)).toEqual([idx.id]);
    expect(safeExistsSync(idx.path)).toBe(false);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ result: 'abandoned' }));
  });

  it('refuses to delete a record re-registered after the sweep took its snapshot', () => {
    const reused = registerWorkspace(
      { path: path.join(base, 'workspaces', 'reused'), kind: 'scratch-dir', owner: {} },
      ledger
    );
    safeWriteFile(path.join(reused.path, 'keep.txt'), 'keep');
    releaseWorkspace(reused.id, ledger);
    registerWorkspace(
      {
        path: path.join(base, 'workspaces', 'trigger'),
        kind: 'scratch-dir',
        owner: { mission_id: 'MSN-X' },
      },
      ledger
    );
    clock = T0 + 48 * HOUR;
    const result = sweepRegisteredWorkspaces(
      sweepOptions({
        // Evaluated after the snapshot, before any deletion: another session
        // re-registers the released path (same ledger id).
        isOwnerTerminal: () => {
          registerWorkspace(
            { path: reused.path, kind: 'scratch-dir', owner: { session_id: 'new' } },
            ledger
          );
          return false;
        },
      })
    );
    expect(result.orphaned.map((r) => r.id)).toEqual([reused.id]);
    expect(result.deleted).toEqual([]);
    expect(result.errors.join('\n')).toContain('WORKSPACE_CHANGED');
    expect(safeExistsSync(path.join(reused.path, 'keep.txt'))).toBe(true);
  });

  it('keeps a released git worktree with uncommitted work past the TTL', () => {
    const repo = path.join(base, 'repo');
    safeMkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
    const dirty = path.join(base, 'worktrees', 'dirty');
    const clean = path.join(base, 'worktrees', 'clean');
    git(repo, ['worktree', 'add', '-q', '--detach', dirty]);
    git(repo, ['worktree', 'add', '-q', '--detach', clean]);
    safeWriteFile(path.join(dirty, 'wip.txt'), 'wip');
    const dirtyRecord = registerWorkspace(
      { path: dirty, kind: 'git-worktree', owner: {}, repoRoot: repo },
      ledger
    );
    const cleanRecord = registerWorkspace(
      { path: clean, kind: 'git-worktree', owner: {}, repoRoot: repo },
      ledger
    );
    releaseWorkspace(dirtyRecord.id, ledger);
    releaseWorkspace(cleanRecord.id, ledger);
    clock = T0 + 48 * HOUR;
    const result = sweepRegisteredWorkspaces(sweepOptions());
    expect(result.deleted.map((r) => r.id)).toEqual([cleanRecord.id]);
    expect(result.errors.join('\n')).toContain('WORKSPACE_DIRTY');
    expect(safeExistsSync(path.join(dirty, 'wip.txt'))).toBe(true);
    expect(safeExistsSync(clean)).toBe(false);
  });

  it('refreshes cached bytes of surviving records (not in dry-run)', () => {
    const live = registerWorkspace(
      { path: path.join(base, 'workspaces', 'live'), kind: 'scratch-dir', owner: {}, bytes: 1 },
      ledger
    );
    sweepRegisteredWorkspaces(sweepOptions({ dryRun: true, measure: () => 123 }));
    expect(listWorkspaces(ledger)[0].bytes).toBe(1);
    sweepRegisteredWorkspaces(sweepOptions({ measure: () => 123 }));
    expect(listWorkspaces(ledger).find((r) => r.id === live.id)?.bytes).toBe(123);
  });

  describe('workspaces whose owning mission can no longer be resolved', () => {
    const missionOwned = (name: string) => {
      const dir = path.join(base, 'workspaces', name);
      safeWriteFile(path.join(dir, 'f.txt'), 'x');
      return registerWorkspace(
        { path: dir, kind: 'scratch-dir', owner: { mission_id: 'MSN-GONE-0001' } },
        ledger
      );
    };
    const unresolvable = { isOwnerResolvable: () => false } as Partial<SweepWorkspacesOptions>;

    it('reports them without deleting by default', () => {
      const record = missionOwned('leak');
      clock = T0 + 100 * HOUR;
      const result = sweepRegisteredWorkspaces(sweepOptions(unresolvable));
      expect(result.unresolvedOwners.map((r) => r.id)).toEqual([record.id]);
      expect(result.deleted).toHaveLength(0);
      expect(listWorkspaces(ledger)).toHaveLength(1);
    });

    it('reclaims them only on an explicit opt-in, after a longer grace than a terminal owner', () => {
      const record = missionOwned('leak');
      const optIn = { ...unresolvable, sweepUnresolvableOwners: true };
      clock = T0 + 30 * HOUR; // past 1x TTL (24h) but inside the 3x grace
      expect(sweepRegisteredWorkspaces(sweepOptions(optIn)).deleted).toHaveLength(0);
      clock = T0 + 100 * HOUR;
      const result = sweepRegisteredWorkspaces(sweepOptions(optIn));
      expect(result.deleted.map((r) => r.id)).toEqual([record.id]);
    });

    it('never reclaims on opt-in from a tenant-bound process (it cannot see other tenants)', () => {
      missionOwned('leak');
      clock = T0 + 100 * HOUR;
      const result = sweepRegisteredWorkspaces(
        sweepOptions({ ...unresolvable, sweepUnresolvableOwners: true, processTenant: 'tenant-a' })
      );
      expect(result.deleted).toHaveLength(0);
      expect(result.errors.join(' ')).toMatch(/tenant-bound/);
    });

    it('leaves a resolvable live owner alone', () => {
      missionOwned('fine');
      clock = T0 + 100 * HOUR;
      const result = sweepRegisteredWorkspaces(
        sweepOptions({ isOwnerResolvable: () => true, sweepUnresolvableOwners: true })
      );
      expect(result.unresolvedOwners).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);
    });
  });
});
