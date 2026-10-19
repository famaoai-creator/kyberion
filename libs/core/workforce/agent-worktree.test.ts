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
  agentWorktreeLaunchHint,
  createAgentWorktree,
  listAgentWorktrees,
  removeAgentWorktree,
  type AgentWorktreeOptions,
} from './agent-worktree.js';
import { listWorkspaces } from './workspace-ledger.js';

let base: string;
let repo: string;
let options: AgentWorktreeOptions;

function git(cwd: string, args: string[]): string {
  const result = safeExecResult('git', args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-agent-wt/${randomUUID()}`);
  repo = path.join(base, 'repo');
  safeMkdir(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Vitest']);
  git(repo, ['config', 'user.email', 'vitest@kyberion.local']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  safeWriteFile(path.join(repo, 'README.md'), 'seed\n');
  safeWriteFile(path.join(repo, '.gitignore'), '.worktrees/\n');
  git(repo, ['add', 'README.md', '.gitignore']);
  git(repo, ['commit', '-q', '-m', 'seed']);
  options = {
    repoRoot: repo,
    worktreesRoot: path.join(base, 'worktrees'),
    registryPath: path.join(base, 'runtime', 'agent-worktrees', 'registry.json'),
    ledger: {
      ledgerPath: path.join(base, 'runtime', 'workspaces', 'ledger.json'),
      allowedRoots: [path.join(base, 'worktrees'), path.join(repo, '.worktrees')],
    },
    budget: { policy: { disk_cap_bytes: 1024 ** 3, min_free_bytes: 0, orphan_ttl_hours: 24 } },
    now: () => new Date('2026-10-19T00:00:00.000Z'),
  };
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  safeExecResult('git', ['worktree', 'prune'], { cwd: repo });
  safeRmSync(base, { recursive: true, force: true });
});

describe('createAgentWorktree', () => {
  it('creates a new untracked branch from the base and records ledger + registry', () => {
    const record = createAgentWorktree({ name: 'codex-1', agent: 'codex', base: 'main' }, options);
    expect(record).toMatchObject({
      name: 'codex-1',
      path: path.join(base, 'worktrees', 'agent-codex-1'),
      branch: 'worktree/codex-1',
      base: 'main',
      agent: 'codex',
      repo_root: repo,
      created_at: '2026-10-19T00:00:00.000Z',
    });
    expect(git(record.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('worktree/codex-1');
    // --no-track: a branch started elsewhere never pushes to its start point.
    expect(
      safeExecResult('git', ['config', 'branch.worktree/codex-1.merge'], { cwd: repo }).status
    ).not.toBe(0);
    const [workspace] = listWorkspaces(options.ledger);
    expect(workspace).toMatchObject({
      id: record.workspace_id,
      kind: 'git-worktree',
      path: record.path,
      owner: { session_id: 'agent-worktree-codex-1' },
    });
    expect(agentWorktreeLaunchHint(record)).toEqual({ cd: `cd ${record.path}`, launch: 'codex' });
  });

  it('checks out an existing branch and rejects --base for it', () => {
    git(repo, ['branch', 'feat/x']);
    expect(() =>
      createAgentWorktree({ name: 'a', branch: 'feat/x', base: 'main' }, options)
    ).toThrow(/applies only to a new branch/);
    const record = createAgentWorktree({ name: 'a', branch: 'feat/x' }, options);
    expect(record.base).toBeNull();
    expect(git(record.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/x');
  });

  it('refuses a branch already checked out elsewhere and drops the ledger record', () => {
    expect(() => createAgentWorktree({ name: 'dup', branch: 'main' }, options)).toThrow(
      /git worktree add failed/
    );
    expect(listWorkspaces(options.ledger)).toEqual([]);
    expect(listAgentWorktrees(options)).toEqual([]);
  });

  it('validates name, agent, base and uniqueness', () => {
    expect(() => createAgentWorktree({ name: 'Bad Name' }, options)).toThrow(/invalid name/);
    expect(() => createAgentWorktree({ name: 'x', agent: 'nope' }, options)).toThrow(
      /unknown agent/
    );
    expect(() => createAgentWorktree({ name: 'x', base: 'no-such-ref' }, options)).toThrow(
      /does not resolve/
    );
    createAgentWorktree({ name: 'x', base: 'main' }, options);
    expect(() => createAgentWorktree({ name: 'x', base: 'main' }, options)).toThrow(
      /AGENT_WORKTREE_EXISTS/
    );
  });

  it('refuses a location inside the checkout that is not gitignored', () => {
    const inside = path.join(repo, 'tracked-dir');
    expect(() =>
      createAgentWorktree(
        { name: 'x', base: 'main' },
        { ...options, worktreesRoot: inside, ledger: { ...options.ledger, allowedRoots: [inside] } }
      )
    ).toThrow(/AGENT_WORKTREE_PATH/);
  });

  it('refuses delegated workers and non-owner roles', () => {
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '1');
    expect(() => createAgentWorktree({ name: 'w', base: 'main' }, options)).toThrow(
      /SESSION_INDEX_OWNER_ONLY/
    );
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
    vi.stubEnv('MISSION_ROLE', 'software_developer');
    expect(() => createAgentWorktree({ name: 'w', base: 'main' }, options)).toThrow(
      /SESSION_INDEX_OWNER_ONLY/
    );
    expect(listWorkspaces(options.ledger)).toEqual([]);
  });
});

describe('listAgentWorktrees', () => {
  it('reports dist freshness against HEAD and dependency state', () => {
    const record = createAgentWorktree({ name: 'c', agent: 'claude', base: 'main' }, options);
    expect(listAgentWorktrees(options)[0]).toMatchObject({
      name: 'c',
      exists: true,
      checked_out: 'worktree/c',
      dist: 'missing',
      deps_installed: false,
    });
    const head = git(record.path, ['rev-parse', 'HEAD']);
    safeMkdir(path.join(record.path, 'dist'), { recursive: true });
    expect(listAgentWorktrees(options)[0].dist).toBe('unstamped');
    safeWriteFile(path.join(record.path, 'dist', '.session-build-head'), `${head}\n`);
    expect(listAgentWorktrees(options)[0]).toMatchObject({ dist: 'fresh', head });
    safeWriteFile(path.join(record.path, 'dist', '.session-build-head'), 'deadbeef\n');
    expect(listAgentWorktrees(options)[0]).toMatchObject({
      dist: 'stale',
      dist_built_from: 'deadbeef',
    });
  });
});

describe('removeAgentWorktree', () => {
  it('removes a clean worktree through the ledger and keeps the branch', () => {
    const record = createAgentWorktree({ name: 'r', base: 'main' }, options);
    const result = removeAgentWorktree({ name: 'r' }, options);
    expect(result).toMatchObject({ removedFromDisk: true, overridden: [] });
    expect(safeExistsSync(record.path)).toBe(false);
    expect(listWorkspaces(options.ledger)).toEqual([]);
    expect(listAgentWorktrees(options)).toEqual([]);
    expect(git(repo, ['branch', '--list', 'worktree/r'])).toContain('worktree/r');
  });

  it('refuses uncommitted work, a live claim and a non-terminal mission unless forced', () => {
    const record = createAgentWorktree(
      { name: 'busy', base: 'main', mission_id: 'MSN-AGENT-WT-UNRESOLVABLE' },
      options
    );
    safeWriteFile(path.join(record.path, 'scratch.txt'), 'wip\n');
    const claim = { item_id: 'wi-1', owner: 'peer-codex' };
    let message = '';
    try {
      removeAgentWorktree({ name: 'busy', claim }, options);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/AGENT_WORKTREE_BUSY/);
    expect(message).toMatch(/uncommitted changes/);
    expect(message).toMatch(/mission MSN-AGENT-WT-UNRESOLVABLE is not terminal/);
    expect(message).toMatch(/claimed by peer-codex/);
    expect(safeExistsSync(record.path)).toBe(true);

    const forced = removeAgentWorktree({ name: 'busy', claim, force: true }, options);
    expect(forced.overridden).toHaveLength(3);
    expect(safeExistsSync(record.path)).toBe(false);
    expect(listAgentWorktrees(options)).toEqual([]);
  });

  it('refuses a delegated worker', () => {
    createAgentWorktree({ name: 'd', base: 'main' }, options);
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '2');
    expect(() => removeAgentWorktree({ name: 'd', force: true }, options)).toThrow(
      /SESSION_INDEX_OWNER_ONLY/
    );
  });

  it('reports an unknown name', () => {
    expect(() => removeAgentWorktree({ name: 'ghost' }, options)).toThrow(
      /AGENT_WORKTREE_NOT_FOUND/
    );
  });
});
