import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitFromSessionIndex } from './mission-git.js';
import * as pathResolver from './path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { prepareSessionGitIndex, type PrepareSessionGitIndexOptions } from './session-git-index.js';
import { listWorkspaces } from './workspace-ledger.js';

let base: string;
let repo: string;
let options: PrepareSessionGitIndexOptions;

function git(cwd: string, args: string[], env?: Record<string, string>, input?: string): string {
  const result = safeExecResult('git', args, {
    cwd,
    ...(env ? { env } : {}),
    ...(input !== undefined ? { input } : {}),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function initRepo(dir: string): void {
  safeMkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Vitest']);
  git(dir, ['config', 'user.email', 'vitest@kyberion.local']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  safeWriteFile(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'seed']);
}

function stagedNames(cwd: string, env?: Record<string, string>): string[] {
  return git(cwd, ['diff', '--cached', '--name-only'], env).split('\n').filter(Boolean).sort();
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-ws/${randomUUID()}`);
  repo = path.join(base, 'repo');
  initRepo(repo);
  options = {
    root: path.join(base, 'git-indexes'),
    ledger: {
      ledgerPath: path.join(base, 'workspaces', 'ledger.json'),
      allowedRoots: [path.join(base, 'git-indexes')],
    },
    budget: { policy: { disk_cap_bytes: 1024 ** 3, min_free_bytes: 0, orphan_ttl_hours: 24 } },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  safeRmSync(base, { recursive: true, force: true });
});

describe('prepareSessionGitIndex', () => {
  it('isolates git add between two sessions and leaves the real index unchanged', () => {
    safeWriteFile(path.join(repo, 'a.txt'), 'a\n');
    safeWriteFile(path.join(repo, 'b.txt'), 'b\n');
    const realIndex = path.join(repo, '.git', 'index');
    const realBefore = safeReadFile(realIndex, { encoding: null });

    const s1 = prepareSessionGitIndex({ cwd: repo, sessionId: 's1' }, options);
    const s2 = prepareSessionGitIndex({ cwd: repo, sessionId: 's2' }, options);
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(path.isAbsolute(s1!.indexPath)).toBe(true);
    expect(s1!.indexPath).not.toBe(s2!.indexPath);

    git(repo, ['add', 'a.txt'], s1!.env);
    git(repo, ['add', 'b.txt'], s2!.env);

    expect(stagedNames(repo, s1!.env)).toEqual(['a.txt']);
    expect(stagedNames(repo, s2!.env)).toEqual(['b.txt']);
    expect(stagedNames(repo)).toEqual([]);
    expect(
      Buffer.compare(safeReadFile(realIndex, { encoding: null }) as Buffer, realBefore as Buffer)
    ).toBe(0);
  });

  it('records the baseline HEAD and registers the index directory in the ledger', () => {
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-ledger' }, options)!;
    expect(idx.baselineSha).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
    expect(idx.repoRoot).toBe(git(repo, ['rev-parse', '--show-toplevel']).trim());
    const records = listWorkspaces(options.ledger);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'git-index',
      path: path.dirname(idx.indexPath),
      owner: { session_id: 's-ledger' },
      live: true,
    });
  });

  it('dispose deletes the index and drops the ledger record', () => {
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-dispose' }, options)!;
    expect(safeExistsSync(idx.indexPath)).toBe(true);
    idx.dispose();
    idx.dispose();
    expect(safeExistsSync(path.dirname(idx.indexPath))).toBe(false);
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });

  it('returns null outside a git work tree', () => {
    // Everything under shared tmp sits inside the Kyberion checkout, so use a
    // git directory, which git reports as not inside a work tree.
    const outside = path.join(repo, '.git');
    expect(prepareSessionGitIndex({ cwd: outside, sessionId: 's-out' }, options)).toBeNull();
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });

  it('refuses (returns null) when the workspace budget denies the copy', () => {
    const idx = prepareSessionGitIndex(
      { cwd: repo, sessionId: 's-budget' },
      {
        ...options,
        budget: { policy: { disk_cap_bytes: 1, min_free_bytes: 0, orphan_ttl_hours: 24 } },
      }
    );
    expect(idx).toBeNull();
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });

  it('rejects a session id that is not a safe path segment', () => {
    expect(prepareSessionGitIndex({ cwd: repo, sessionId: '../escape' }, options)).toBeNull();
  });

  it('seeds a linked worktree from its own HEAD', () => {
    const worktree = path.join(base, 'wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', worktree]);
    safeWriteFile(path.join(worktree, 'only-in-wt.txt'), 'wt\n');
    git(worktree, ['add', 'only-in-wt.txt']);
    git(worktree, ['commit', '-q', '-m', 'wt only']);

    const idx = prepareSessionGitIndex({ cwd: worktree, sessionId: 's-wt' }, options)!;
    expect(idx.repoRoot).toBe(git(worktree, ['rev-parse', '--show-toplevel']).trim());
    expect(idx.baselineSha).toBe(git(worktree, ['rev-parse', 'HEAD']).trim());
    expect(git(worktree, ['ls-files'], idx.env)).toContain('only-in-wt.txt');
    expect(stagedNames(worktree, idx.env)).toEqual([]);
  });

  it('seeds from HEAD, never from work other sessions staged in the shared index', () => {
    safeWriteFile(path.join(repo, 'other.txt'), 'other\n');
    git(repo, ['add', 'other.txt']);
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-seed' }, options)!;
    expect(stagedNames(repo, idx.env)).toEqual([]);
  });

  it('records the registering process and the attached child in the ledger', () => {
    const idx = prepareSessionGitIndex(
      { cwd: repo, sessionId: 's-pid' },
      { ...options, processProbe: { startMarker: () => 'marker-1' } }
    )!;
    idx.attachChild(4321);
    expect(listWorkspaces(options.ledger)[0]).toMatchObject({
      pid: process.pid,
      pidStartedAt: 'marker-1',
      childPid: 4321,
    });
  });

  it('keeps the index while the child may still run and deletes it on a later dispose', () => {
    let childRunning = true;
    const idx = prepareSessionGitIndex(
      { cwd: repo, sessionId: 's-child' },
      { ...options, processProbe: { isPidAlive: () => childRunning, startMarker: () => 'm' } }
    )!;
    idx.dispose({ childPid: 999 });
    expect(safeExistsSync(idx.indexPath)).toBe(true);
    expect(listWorkspaces(options.ledger)[0]).toMatchObject({ live: false, childPid: 999 });

    childRunning = false;
    idx.dispose({ childPid: 999 });
    expect(safeExistsSync(path.dirname(idx.indexPath))).toBe(false);
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });
});

describe('dispose after a worker committed through its private index', () => {
  it("keeps the worker commit in the owner's next commit without clobbering owner-staged work", () => {
    const audit = vi.fn();
    const idx = prepareSessionGitIndex(
      { cwd: repo, sessionId: 's-worker-commit' },
      {
        ...options,
        audit,
      }
    )!;
    // The worker edits README.md and adds a.txt, then commits with its private index.
    safeWriteFile(path.join(repo, 'a.txt'), 'worker\n');
    safeWriteFile(path.join(repo, 'README.md'), 'worker readme\n');
    git(repo, ['add', 'a.txt', 'README.md'], idx.env);
    git(repo, ['commit', '-q', '-m', 'worker commit'], idx.env);
    const workerCommit = git(repo, ['rev-parse', 'HEAD']).trim();

    // Meanwhile the owner staged its own README.md in the shared index.
    const ownerReadme = git(
      repo,
      ['hash-object', '-w', '--stdin'],
      undefined,
      'owner readme\n'
    ).trim();
    git(repo, ['update-index', '--cacheinfo', `100644,${ownerReadme},README.md`]);

    idx.dispose();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ toSha: workerCommit, updated: ['a.txt'], skipped: ['README.md'] })
    );

    safeWriteFile(path.join(repo, 'b.txt'), 'owner\n');
    git(repo, ['add', 'b.txt']);
    git(repo, ['commit', '-q', '-m', 'owner commit']);
    const tree = git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    expect(tree.sort()).toEqual(['README.md', 'a.txt', 'b.txt']);
    expect(git(repo, ['show', 'HEAD:a.txt'])).toBe('worker\n');
    expect(git(repo, ['show', 'HEAD:README.md'])).toBe('owner readme\n');
    expect(git(repo, ['diff', '--name-only', 'HEAD~1', 'HEAD']).trim().split('\n').sort()).toEqual([
      'README.md',
      'b.txt',
    ]);
  });

  it('does nothing when HEAD did not move', () => {
    const audit = vi.fn();
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-still' }, { ...options, audit })!;
    idx.dispose();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('commitFromSessionIndex', () => {
  beforeEach(() => {
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
  });

  it('commits the private index and refreshes the shared index for those paths', () => {
    safeWriteFile(path.join(repo, 'a.txt'), 'a\n');
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-commit' }, options)!;
    git(repo, ['add', 'a.txt'], idx.env);
    const result = commitFromSessionIndex(idx, 'feat: a');
    expect(result.paths).toEqual(['a.txt']);
    expect(result.sha).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('a.txt');
    expect(stagedNames(repo)).toEqual([]);
  });

  it('never commits work another session staged in the shared index', () => {
    safeWriteFile(path.join(repo, 'other.txt'), 'other\n');
    git(repo, ['add', 'other.txt']);
    safeWriteFile(path.join(repo, 'a.txt'), 'a\n');
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-isolated' }, options)!;
    git(repo, ['add', 'a.txt'], idx.env);
    const result = commitFromSessionIndex(idx, 'feat: a');
    expect(result.paths).toEqual(['a.txt']);
    expect(git(repo, ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('a.txt');
    expect(stagedNames(repo)).toEqual(['other.txt']);
  });

  it('fails closed when HEAD moves between the check and the ref update', () => {
    safeWriteFile(path.join(repo, 'a.txt'), 'a\n');
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-race' }, options)!;
    git(repo, ['add', 'a.txt'], idx.env);
    let raced = '';
    expect(() =>
      commitFromSessionIndex(idx, 'feat: a', {
        beforeRefUpdate: () => {
          git(repo, ['commit', '-q', '--allow-empty', '-m', 'someone else']);
          raced = git(repo, ['rev-parse', 'HEAD']).trim();
        },
      })
    ).toThrow(/SESSION_INDEX_STALE/);
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(raced);
  });

  it('refuses a stale baseline after HEAD moved', () => {
    safeWriteFile(path.join(repo, 'a.txt'), 'a\n');
    safeWriteFile(path.join(repo, 'other.txt'), 'other\n');
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-stale' }, options)!;
    git(repo, ['add', 'a.txt'], idx.env);
    git(repo, ['add', 'other.txt']);
    git(repo, ['commit', '-q', '-m', 'someone else']);
    const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();
    expect(() => commitFromSessionIndex(idx, 'feat: a')).toThrow(/SESSION_INDEX_STALE/);
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('refuses on a delegated worker path', () => {
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '1');
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-worker' }, options)!;
    expect(() => commitFromSessionIndex(idx, 'feat: x')).toThrow(/SESSION_INDEX_OWNER_ONLY/);
  });

  it('refuses a non-owner role', () => {
    vi.stubEnv('MISSION_ROLE', 'worker');
    const idx = prepareSessionGitIndex({ cwd: repo, sessionId: 's-role' }, options)!;
    expect(() => commitFromSessionIndex(idx, 'feat: x')).toThrow(/SESSION_INDEX_OWNER_ONLY/);
  });
});
