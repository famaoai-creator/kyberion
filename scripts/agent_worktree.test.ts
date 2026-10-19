import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import {
  runAgentWorktreeCli,
  type AgentWorktreeCliOptions,
  type CreateCliResult,
  type ListCliResult,
} from './agent_worktree.js';

let base: string;
let repo: string;
let options: AgentWorktreeCliOptions;
let printed: unknown[];
const print = (value: unknown) => printed.push(value);

function git(cwd: string, args: string[]): string {
  const result = safeExecResult('git', args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const run = (positional: string[], json = true) =>
  runAgentWorktreeCli({ positional, json }, print, options);

beforeEach(() => {
  base = pathResolver.sharedTmp(`vitest-agent-wt-cli/${randomUUID()}`);
  repo = path.join(base, 'repo');
  safeMkdir(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Vitest']);
  git(repo, ['config', 'user.email', 'vitest@kyberion.local']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  safeWriteFile(path.join(repo, 'README.md'), 'seed\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'seed']);
  printed = [];
  options = {
    repoRoot: repo,
    worktreesRoot: path.join(base, 'worktrees'),
    registryPath: path.join(base, 'runtime', 'agent-worktrees', 'registry.json'),
    ledger: {
      ledgerPath: path.join(base, 'runtime', 'workspaces', 'ledger.json'),
      allowedRoots: [path.join(base, 'worktrees')],
    },
    budget: { policy: { disk_cap_bytes: 1024 ** 3, min_free_bytes: 0, orphan_ttl_hours: 24 } },
    resolveClaim: () => null,
  };
  // A plain operator shell: no explicit role, not delegated.
  vi.stubEnv('MISSION_ROLE', '');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  safeExecResult('git', ['worktree', 'prune'], { cwd: repo });
  safeRmSync(base, { recursive: true, force: true });
});

describe('kyberion worktree', () => {
  it('create → list → remove for an operator shell', async () => {
    const created = (await run([
      'create',
      'devin-a',
      '--agent',
      'devin',
      '--base=main',
      '--branch',
      'feat/devin-a',
    ])) as CreateCliResult;
    expect(created.worktree).toMatchObject({ name: 'devin-a', branch: 'feat/devin-a' });
    expect(created.bootstrap).toBeNull();
    expect(created.hint.launch).toBe('devin');

    options.resolveClaim = (branch) =>
      branch === 'feat/devin-a' ? { item_id: 'wi-7', owner: 'peer-devin' } : null;
    const listed = (await run(['list'])) as ListCliResult;
    expect(listed.claimLookup).toBe(true);
    expect(listed.worktrees[0]).toMatchObject({
      name: 'devin-a',
      agent: 'devin',
      dist: 'missing',
      claim: { item_id: 'wi-7', owner: 'peer-devin' },
    });
    printed = [];
    await run(['list'], false);
    expect(String(printed[0])).toMatch(
      /devin-a {2}feat\/devin-a {2}devin .* owner:peer-devin \(wi-7\)/
    );

    await expect(run(['remove', 'devin-a'])).rejects.toThrow(/claimed by peer-devin/);
    options.resolveClaim = () => null;
    await run(['remove', 'devin-a']);
    expect(safeExistsSync(created.worktree.path)).toBe(false);
  });

  it('marks the owner column unavailable without a claim lookup', async () => {
    options.resolveClaim = null;
    await run(['create', 'g', '--base', 'main', '--agent', 'gemini']);
    const listed = (await run(['list'])) as ListCliResult;
    expect(listed.claimLookup).toBe(false);
    expect(listed.worktrees[0]).not.toHaveProperty('claim');
    printed = [];
    await run(['list'], false);
    expect(String(printed[0])).toContain('owner:n/a');
  });

  it('runs the bootstrap and fails the command when a step fails', async () => {
    options.bootstrap = () => [
      { command: 'pnpm install --prefer-offline', status: 0 },
      { command: 'pnpm run build', status: 1, detail: 'tsc error' },
    ];
    await expect(run(['create', 'b', '--base', 'main', '--bootstrap'])).rejects.toMatchObject({
      code: 1,
    });
  });

  it('refuses worker-scoped processes', async () => {
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '1');
    await expect(run(['create', 'w', '--base', 'main'])).rejects.toThrow(
      /AGENT_WORKTREE_OWNER_ONLY/
    );
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
    vi.stubEnv('MISSION_ROLE', 'software_developer');
    await expect(run(['remove', 'w'])).rejects.toThrow(/AGENT_WORKTREE_OWNER_ONLY/);
    expect(safeExistsSync(path.join(base, 'worktrees', 'agent-w'))).toBe(false);
  });

  it('rejects malformed arguments with exit code 2', async () => {
    for (const argv of [
      [],
      ['create'],
      ['create', 'x', '--branch'],
      ['create', 'x', '--force'],
      ['list', '--agent', 'claude'],
      ['remove', 'x', '--nope'],
      ['frobnicate'],
    ]) {
      const error = await run(argv).catch((caught: unknown) => caught);
      expect(error, argv.join(' ')).toBeInstanceOf(ScriptExitError);
      expect((error as ScriptExitError).code, argv.join(' ')).toBe(2);
    }
  });
});
