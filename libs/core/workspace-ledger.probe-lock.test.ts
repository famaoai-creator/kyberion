import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lockState = vi.hoisted(() => ({
  held: 0,
  statusUnderLock: [] as boolean[],
  onStatus: undefined as (() => void) | undefined,
}));

vi.mock('./src/lock-utils.js', async () => {
  const actual = await vi.importActual<typeof import('./src/lock-utils.js')>('./src/lock-utils.js');
  return {
    ...actual,
    withLockSync: <T>(id: string, fn: () => T): T =>
      actual.withLockSync(id, () => {
        lockState.held += 1;
        try {
          return fn();
        } finally {
          lockState.held -= 1;
        }
      }),
  };
});

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExecResult: (...args: Parameters<typeof actual.safeExecResult>) => {
      if (args[0] === 'git' && args[1]?.[0] === 'status') {
        lockState.statusUnderLock.push(lockState.held > 0);
        lockState.onStatus?.();
      }
      return actual.safeExecResult(...args);
    },
  };
});

import * as pathResolver from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeMkdir, safeRmSync } from './secure-io.js';
import {
  deleteRegisteredWorkspace,
  listWorkspaces,
  registerWorkspace,
  releaseWorkspace,
  workspaceRecordSnapshot,
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
  base = pathResolver.sharedTmp(`vitest-ws/${randomUUID()}`);
  options = {
    ledgerPath: path.join(base, 'workspaces', 'ledger.json'),
    allowedRoots: [path.join(base, 'worktrees')],
  };
  lockState.held = 0;
  lockState.statusUnderLock = [];
  lockState.onStatus = undefined;
});

afterEach(() => {
  safeRmSync(base, { recursive: true, force: true });
});

describe('deleteRegisteredWorkspace clean-tree probe', () => {
  function cleanWorktree(name: string) {
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
    git(repo, ['branch', 'keep']);
    const worktree = path.join(base, 'worktrees', name);
    git(repo, ['worktree', 'add', '-q', '--detach', worktree]);
    const record = registerWorkspace(
      { path: worktree, kind: 'git-worktree', owner: {}, repoRoot: repo },
      options
    );
    return { repo, worktree, record };
  }

  it('refuses when the record is reactivated while the probe runs', () => {
    const { repo, worktree, record } = cleanWorktree('wt-race');
    const released = releaseWorkspace(record.id, options)!;
    lockState.onStatus = () => {
      registerWorkspace(
        { path: worktree, kind: 'git-worktree', owner: {}, repoRoot: repo },
        options
      );
    };
    expect(() =>
      deleteRegisteredWorkspace(record.id, options, {
        requireCleanWorktree: true,
        expect: workspaceRecordSnapshot(released),
      })
    ).toThrow('WORKSPACE_CHANGED');
    expect(safeExistsSync(worktree)).toBe(true);
  });

  it('runs git status outside the ledger lock and still deletes a clean worktree', () => {
    const { worktree, record } = cleanWorktree('wt');

    deleteRegisteredWorkspace(record.id, options, { requireCleanWorktree: true });
    expect(lockState.statusUnderLock).toEqual([false]);
    expect(safeExistsSync(worktree)).toBe(false);
    expect(listWorkspaces(options)).toEqual([]);
  });
});
