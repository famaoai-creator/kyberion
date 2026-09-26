import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  annotateWorkspace,
  createScratchWorkspace,
  deleteRegisteredWorkspace,
  listUnregisteredWorkspaceDirs,
  listWorkspaces,
  registerWorkspace,
  releaseWorkspace,
  type WorkspaceLedgerOptions,
} from './workspace-ledger.js';

let base: string;
let options: WorkspaceLedgerOptions;

function git(cwd: string, args: string[]): string {
  const result = safeExecResult('git', args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-ws-ledger/${randomUUID()}`);
  options = {
    ledgerPath: path.join(base, 'workspaces', 'ledger.json'),
    allowedRoots: [
      path.join(base, 'workspaces'),
      path.join(base, 'worktrees'),
      path.join(base, 'git-indexes'),
    ],
    now: () => new Date('2026-09-26T00:00:00.000Z'),
  };
  safeMkdir(path.join(base, 'workspaces'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  safeRmSync(base, { recursive: true, force: true });
});

describe('workspace-ledger', () => {
  it('registers a workspace under its canonical absolute path', () => {
    const dir = path.join(base, 'workspaces', 'a');
    safeMkdir(dir, { recursive: true });
    const record = registerWorkspace(
      {
        path: path.relative(pathResolver.rootDir(), dir),
        kind: 'scratch-dir',
        owner: { session_id: 's1' },
      },
      options
    );
    expect(record.path).toBe(dir);
    expect(record.live).toBe(true);
    expect(record.createdAt).toBe('2026-09-26T00:00:00.000Z');
    expect(record.id).toMatch(/^ws-/);
    expect(listWorkspaces(options)).toEqual([record]);
  });

  it('reactivates the same entry on re-registration and rejects a kind change', () => {
    const dir = path.join(base, 'workspaces', 'b');
    const first = registerWorkspace({ path: dir, kind: 'scratch-dir', owner: {} }, options);
    releaseWorkspace(first.id, options);
    const second = registerWorkspace(
      { path: dir, kind: 'scratch-dir', owner: { mission_id: 'MSN-1' } },
      options
    );
    expect(second.id).toBe(first.id);
    expect(second.live).toBe(true);
    expect(second.releasedAt).toBeUndefined();
    expect(listWorkspaces(options)).toHaveLength(1);
    expect(() => registerWorkspace({ path: dir, kind: 'git-index', owner: {} }, options)).toThrow(
      'WORKSPACE_KIND_CONFLICT'
    );
  });

  it('rejects paths outside the allowed roots, the root itself and the ledger file', () => {
    expect(() =>
      registerWorkspace(
        { path: path.join(base, 'elsewhere', 'x'), kind: 'scratch-dir', owner: {} },
        options
      )
    ).toThrow('outside the allowed roots');
    expect(() =>
      registerWorkspace(
        { path: path.join(base, 'workspaces'), kind: 'scratch-dir', owner: {} },
        options
      )
    ).toThrow('outside the allowed roots');
    expect(() =>
      registerWorkspace(
        { path: path.join(base, 'workspaces', '..', 'elsewhere'), kind: 'scratch-dir', owner: {} },
        options
      )
    ).toThrow('outside the allowed roots');
    expect(() =>
      registerWorkspace({ path: options.ledgerPath!, kind: 'scratch-dir', owner: {} }, options)
    ).toThrow('ledger file cannot be a workspace');
  });

  it('rejects symlinked workspace paths', () => {
    const target = path.join(base, 'elsewhere');
    safeMkdir(target, { recursive: true });
    const link = path.join(base, 'workspaces', 'link');
    safeSymlinkSync(target, link, 'dir');
    expect(() =>
      registerWorkspace({ path: link, kind: 'scratch-dir', owner: {} }, options)
    ).toThrow('RESOURCE_PATH_SYMLINK');
    expect(() =>
      registerWorkspace({ path: path.join(link, 'inner'), kind: 'scratch-dir', owner: {} }, options)
    ).toThrow('RESOURCE_PATH_SYMLINK');
  });

  it('releases a workspace', () => {
    const record = registerWorkspace(
      { path: path.join(base, 'workspaces', 'c'), kind: 'scratch-dir', owner: {} },
      options
    );
    const released = releaseWorkspace(record.id, options);
    expect(released).toMatchObject({ live: false, releasedAt: '2026-09-26T00:00:00.000Z' });
    expect(releaseWorkspace('ws-unknown', options)).toBeNull();
  });

  it('deletes a registered scratch workspace and drops its record', () => {
    const record = createScratchWorkspace(
      { task_id: 't1' },
      { ...options, root: path.join(base, 'workspaces') }
    );
    expect(record.path).toBe(path.join(base, 'workspaces', record.id));
    safeWriteFile(path.join(record.path, 'file.txt'), 'data');
    const result = deleteRegisteredWorkspace(record.id, options);
    expect(result.removedFromDisk).toBe(true);
    expect(safeExistsSync(record.path)).toBe(false);
    expect(listWorkspaces(options)).toEqual([]);
    expect(() => deleteRegisteredWorkspace(record.id, options)).toThrow('WORKSPACE_NOT_REGISTERED');
  });

  it('refuses to delete a registered path that has become a symlink', () => {
    const dir = path.join(base, 'workspaces', 'd');
    safeMkdir(dir, { recursive: true });
    const record = registerWorkspace({ path: dir, kind: 'scratch-dir', owner: {} }, options);
    const victim = path.join(base, 'victim');
    safeWriteFile(path.join(victim, 'keep.txt'), 'keep');
    safeRmSync(dir, { recursive: true, force: true });
    safeSymlinkSync(victim, dir, 'dir');
    expect(() => deleteRegisteredWorkspace(record.id, options)).toThrow('RESOURCE_PATH_SYMLINK');
    expect(safeExistsSync(path.join(victim, 'keep.txt'))).toBe(true);
    expect(listWorkspaces(options)).toHaveLength(1);
  });

  it('removes a git worktree through git worktree remove on the owner path only', () => {
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
    const worktree = path.join(base, 'worktrees', 'wt1');
    git(repo, ['worktree', 'add', '-q', '--detach', worktree]);
    const record = registerWorkspace(
      { path: worktree, kind: 'git-worktree', owner: { mission_id: 'MSN-1' }, repoRoot: repo },
      options
    );

    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '1');
    expect(() => deleteRegisteredWorkspace(record.id, options)).toThrow('WORKSPACE_OWNER_ONLY');
    expect(safeExistsSync(worktree)).toBe(true);
    vi.unstubAllEnvs();

    deleteRegisteredWorkspace(record.id, options);
    expect(safeExistsSync(worktree)).toBe(false);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(worktree);
    expect(listWorkspaces(options)).toEqual([]);
  });

  it('refuses a snapshot-guarded delete when the record was re-registered in between', () => {
    const dir = path.join(base, 'workspaces', 'race');
    safeWriteFile(path.join(dir, 'keep.txt'), 'keep');
    const first = registerWorkspace({ path: dir, kind: 'scratch-dir', owner: {} }, options);
    const snapshot = releaseWorkspace(first.id, options)!;
    // Another session reuses the path (same id) before the reclaimer acts.
    const again = registerWorkspace(
      { path: dir, kind: 'scratch-dir', owner: { session_id: 's-new' } },
      options
    );
    expect(again.id).toBe(first.id);
    expect(() =>
      deleteRegisteredWorkspace(first.id, options, {
        expect: {
          live: snapshot.live,
          createdAt: snapshot.createdAt,
          releasedAt: snapshot.releasedAt,
        },
      })
    ).toThrow('WORKSPACE_CHANGED');
    expect(safeExistsSync(path.join(dir, 'keep.txt'))).toBe(true);
    expect(listWorkspaces(options)).toHaveLength(1);

    const released = releaseWorkspace(first.id, options)!;
    deleteRegisteredWorkspace(first.id, options, {
      expect: { live: false, createdAt: released.createdAt, releasedAt: released.releasedAt },
    });
    expect(safeExistsSync(dir)).toBe(false);
  });

  it('keeps a git worktree with uncommitted or unreachable work when a clean tree is required', () => {
    const repo = path.join(base, 'repo');
    safeMkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    const commit = (cwd: string, message: string) =>
      git(cwd, [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        message,
      ]);
    commit(repo, 'init');
    const worktree = path.join(base, 'worktrees', 'wt-dirty');
    git(repo, ['worktree', 'add', '-q', '--detach', worktree]);
    const record = registerWorkspace(
      { path: worktree, kind: 'git-worktree', owner: {}, repoRoot: repo },
      options
    );

    safeWriteFile(path.join(worktree, 'wip.txt'), 'wip');
    expect(() =>
      deleteRegisteredWorkspace(record.id, options, { requireCleanWorktree: true })
    ).toThrow(/WORKSPACE_DIRTY.*uncommitted/);
    safeRmSync(path.join(worktree, 'wip.txt'));

    commit(worktree, 'detached work');
    expect(() =>
      deleteRegisteredWorkspace(record.id, options, { requireCleanWorktree: true })
    ).toThrow(/WORKSPACE_DIRTY.*not reachable/);
    expect(safeExistsSync(worktree)).toBe(true);

    git(worktree, ['branch', 'keep-work']);
    deleteRegisteredWorkspace(record.id, options, { requireCleanWorktree: true });
    expect(safeExistsSync(worktree)).toBe(false);
  });

  it('records the registering process and annotates cached bytes and the child pid', () => {
    const dir = path.join(base, 'git-indexes', 'sess');
    const record = registerWorkspace(
      { path: dir, kind: 'git-index', owner: {}, pid: 4242, pidStartedAt: 'marker', bytes: 7 },
      options
    );
    expect(record).toMatchObject({ pid: 4242, pidStartedAt: 'marker', bytes: 7 });
    expect(annotateWorkspace(record.id, { bytes: 9, childPid: 77 }, options)).toMatchObject({
      bytes: 9,
      childPid: 77,
    });
    expect(releaseWorkspace(record.id, options, { bytes: 11 })).toMatchObject({ bytes: 11 });
    const reused = registerWorkspace({ path: dir, kind: 'git-index', owner: {} }, options);
    expect(reused.pid).toBeUndefined();
    expect(reused.childPid).toBeUndefined();
  });

  it('reports unregistered directories without deleting them', () => {
    const registered = path.join(base, 'workspaces', 'reg');
    const stray = path.join(base, 'worktrees', 'stray');
    const indexFile = path.join(base, 'git-indexes', 'sess-1', 'index');
    safeMkdir(registered, { recursive: true });
    safeMkdir(stray, { recursive: true });
    safeWriteFile(indexFile, 'idx');
    registerWorkspace({ path: registered, kind: 'scratch-dir', owner: {} }, options);
    registerWorkspace({ path: indexFile, kind: 'git-index', owner: {} }, options);
    expect(listUnregisteredWorkspaceDirs(options)).toEqual([stray]);
    expect(safeExistsSync(stray)).toBe(true);
  });

  it('rejects a ledger that violates the schema', () => {
    safeWriteFile(options.ledgerPath!, JSON.stringify([{ id: 'bad', path: 'x' }]));
    expect(() => listWorkspaces(options)).toThrow('Invalid catalog workspace-ledger');
  });
});
