import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import {
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
});
