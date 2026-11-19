import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionWorktree,
  ensureMissionRepoMediaIgnores,
  stageMissionRepoChanges,
  type CreateSessionWorktreeOptions,
} from './mission-git.js';
import * as pathResolver from '../path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { deleteRegisteredWorkspace, listWorkspaces } from '../workforce/workspace-ledger.js';

let base: string;
let repo: string;
let options: CreateSessionWorktreeOptions;

function git(cwd: string, args: string[]): string {
  const result = safeExecResult('git', args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-ws/${randomUUID()}`);
  repo = path.join(base, 'repo');
  safeMkdir(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Vitest']);
  git(repo, ['config', 'user.email', 'vitest@kyberion.local']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  safeWriteFile(path.join(repo, 'README.md'), 'seed\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'seed']);
  options = {
    root: path.join(base, 'worktrees'),
    ledger: {
      ledgerPath: path.join(base, 'workspaces', 'ledger.json'),
      allowedRoots: [path.join(base, 'worktrees')],
    },
    budget: { policy: { disk_cap_bytes: 1024 ** 3, min_free_bytes: 0, orphan_ttl_hours: 24 } },
  };
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  safeExecResult('git', ['worktree', 'prune'], { cwd: repo });
  safeRmSync(base, { recursive: true, force: true });
});

describe('createSessionWorktree', () => {
  it('registers then creates a detached worktree, removable only through the ledger', () => {
    const record = createSessionWorktree(
      { sessionId: 's-wt', repoRoot: repo, owner: { mission_id: 'MSN-1' } },
      options
    );
    expect(record).toMatchObject({
      kind: 'git-worktree',
      path: path.join(base, 'worktrees', 's-wt'),
      repoRoot: repo,
      owner: { mission_id: 'MSN-1', session_id: 's-wt' },
    });
    expect(safeExistsSync(path.join(record.path, 'README.md'))).toBe(true);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(record.path);

    deleteRegisteredWorkspace(record.id, options.ledger);
    expect(safeExistsSync(record.path)).toBe(false);
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });

  it('refuses on a delegated worker path', () => {
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '1');
    expect(() => createSessionWorktree({ sessionId: 's-w', repoRoot: repo }, options)).toThrow(
      /SESSION_INDEX_OWNER_ONLY/
    );
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });

  it('refuses when the workspace budget denies it', () => {
    expect(() =>
      createSessionWorktree(
        { sessionId: 's-b', repoRoot: repo },
        {
          ...options,
          budget: {
            policy: { disk_cap_bytes: 0, min_free_bytes: 1, orphan_ttl_hours: 24 },
            statfs: () => ({ freeBytes: 0 }),
          },
        }
      )
    ).toThrow(/SESSION_WORKTREE_BUDGET.*free-disk-floor/);
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });

  it('drops the ledger record when git worktree add fails', () => {
    expect(() =>
      createSessionWorktree({ sessionId: 's-bad', repoRoot: repo, ref: 'no-such-ref' }, options)
    ).toThrow(/git worktree add failed/);
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });
});

describe('mission repo media ignores', () => {
  it('appends the media ignores idempotently, keeping existing lines', () => {
    safeWriteFile(path.join(repo, '.gitignore'), 'node_modules/');
    const added = ensureMissionRepoMediaIgnores(repo);
    expect(added).toContain('evidence/audio/');
    expect(added).toContain('*.wav');
    const text = String(safeReadFile(path.join(repo, '.gitignore'), { encoding: 'utf8' }));
    expect(text.startsWith('node_modules/\n')).toBe(true);
    expect(ensureMissionRepoMediaIgnores(repo)).toEqual([]);
    expect(String(safeReadFile(path.join(repo, '.gitignore'), { encoding: 'utf8' }))).toBe(text);
  });

  it('stages evidence but never meeting audio, without deleting the audio', () => {
    safeMkdir(path.join(repo, 'evidence/audio'), { recursive: true });
    safeWriteFile(path.join(repo, 'evidence/audio/segment-001.wav'), 'RIFF');
    safeWriteFile(path.join(repo, 'evidence/clip.m4a'), 'm4a');
    safeWriteFile(path.join(repo, 'evidence/minutes.md'), '# minutes\n');

    expect(stageMissionRepoChanges(repo)).toBe(true);
    const staged = git(repo, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    expect(staged).toEqual(expect.arrayContaining(['.gitignore', 'evidence/minutes.md']));
    expect(staged.some((file) => file.includes('audio') || file.endsWith('.m4a'))).toBe(false);
    expect(safeExistsSync(path.join(repo, 'evidence/audio/segment-001.wav'))).toBe(true);
  });

  it('never stages into an enclosing checkout when the mission has no repo', () => {
    const notRepo = path.join(base, 'not-a-repo');
    safeMkdir(notRepo, { recursive: true });
    expect(stageMissionRepoChanges(notRepo)).toBe(false);
  });
});
