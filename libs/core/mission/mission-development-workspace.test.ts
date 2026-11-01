import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import {
  safeExecResult,
  safeMkdir,
  safeWriteFile,
  safeRmSync,
  safeChmodSync,
} from '../secure-io.js';
import { prepareMissionDevelopmentWorkspace } from './mission-development-workspace.js';
import { createDevelopmentWorkspaceGitRunner } from './mission-development-git.js';
let root: string;
let owned: boolean;
const write = (file: string, text: string) =>
  withExecutionContext('mission_controller', () => safeWriteFile(file, text));
function git(args: string[]) {
  const result = safeExecResult('git', args, { cwd: root });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || 'Fixture git failed');
  return result.stdout.trim();
}
const run = (commit = false) =>
  withExecutionContext('mission_controller', () =>
    prepareMissionDevelopmentWorkspace(
      {
        cwd: root,
        sourcePaths: ['libs/core/example.ts'],
        owned,
        commit,
        taskId: 'implementation',
        assertCurrent: () => {},
        reserve: () => {
          owned = true;
        },
      },
      undefined,
      root
    )
  );
beforeEach(() => {
  root = pathResolver.sharedTmp(`development-workspace-${randomUUID()}`);
  safeMkdir(path.join(root, 'libs/core'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  safeWriteFile(path.join(root, 'package.json'), '{}');
  safeWriteFile(path.join(root, 'libs/core/example.ts'), 'export const example = 1;\n');
  git(['add', 'package.json', 'libs/core/example.ts']);
  git(['commit', '-qm', 'seed']);
  vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
  owned = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  safeRmSync(root, { recursive: true, force: true });
});
describe('owner candidate workspace with real git', () => {
  it('creates the candidate and commits approved implementation and repair files without manual git work', () => {
    expect(run()).toBe('advanced');
    expect(git(['branch', '--show-current'])).toBe('agent/kyberion-development');
    const initial = git(['rev-parse', 'HEAD']);
    write(path.join(root, 'libs/core/example.ts'), 'export const example = 2;\n');
    expect(run(true)).toBe('advanced');
    expect(git(['rev-parse', 'HEAD'])).not.toBe(initial);
    write(path.join(root, 'libs/core/example.ts'), 'export const example = 3;\n');
    expect(run(true)).toBe('advanced');
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['log', '-2', '--format=%s'])).toBe(
      'feat: implement implementation\nfeat: implement implementation'
    );
  });
  it('does not adopt an unowned existing candidate', () => {
    git(['checkout', '-qb', 'agent/kyberion-development']);
    expect(() => run()).toThrow('not owned');
  });
  it('refuses even read probes from delegated workers through the owner-only adapter', () => {
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '1');
    expect(() =>
      withExecutionContext('mission_controller', () =>
        createDevelopmentWorkspaceGitRunner(root, ['libs/core/example.ts'], 'implementation')(
          'git',
          ['rev-parse', 'HEAD'],
          { cwd: root }
        )
      )
    ).toThrow('mission owner only');
  });
  it('commits through the closed owner adapter without invoking repository hooks', () => {
    safeMkdir(path.join(root, 'hooks'), { recursive: true });
    safeWriteFile(path.join(root, 'hooks/pre-commit'), '#!/bin/sh\nexit 91\n');
    safeChmodSync(path.join(root, 'hooks/pre-commit'), 0o755);
    safeWriteFile(path.join(root, '.gitignore'), 'hooks/\n');
    git(['add', '.gitignore']);
    git(['commit', '-qm', 'ignore fixture hooks']);
    git(['config', 'core.hooksPath', path.join(root, 'hooks')]);
    run();
    write(path.join(root, 'libs/core/example.ts'), 'export const example = 2;\n');
    expect(run(true)).toBe('advanced');
  });
  it('rejects unrelated changes and preserves the worktree', () => {
    run();
    write(path.join(root, 'unrelated.txt'), 'unrelated');
    expect(() => run(true)).toThrow('exceed');
    expect(git(['status', '--porcelain'])).toContain('unrelated.txt');
  });
  it('does not commit preexisting staged changes or permit delegated worker git writes', () => {
    run();
    write(path.join(root, 'libs/core/example.ts'), 'export const example = 2;\n');
    git(['add', '--', 'libs/core/example.ts']);
    expect(() => run(true)).toThrow('Preexisting staged');
    git(['reset', '-q', 'HEAD']);
    vi.stubEnv('KYBERION_DELEGATION_DEPTH', '1');
    expect(() => run(true)).toThrow('mission owner only');
  });
});
