import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as io from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { hardenedGitProbeArgs, runHardenedGitProbe } from './git-probe-hardening.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) io.safeRmSync(root);
});
function git(cwd: string, args: string[]) {
  const result = io.safeExecResult('git', args, { cwd });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

describe('automatic Git probe hardening', () => {
  it('hardens only closed object/index probe forms and rejects worktree/submodule/executable options', () => {
    const sha = 'a'.repeat(40);
    expect(hardenedGitProbeArgs(['diff-tree', '-r', '-z', '--no-renames', sha, sha])).toEqual([
      'diff-tree',
      '--no-ext-diff',
      '--no-textconv',
      '-r',
      '-z',
      '--no-renames',
      sha,
      sha,
    ]);
    for (const args of [
      ['commit'],
      ['diff', '--ext-diff'],
      ['diff', '--output=x'],
      ['cat-file', '--filters'],
      ['status', '--porcelain'],
      ['diff', '--', 'README.md'],
      ['diff-tree', '-r', '-z', '--no-renames', 'HEAD', 'HEAD'],
      ['ls-files', '-s', '-z', '--recurse-submodules'],
    ]) {
      expect(() => hardenedGitProbeArgs(args)).toThrow('GIT_PROBE_UNAVAILABLE');
    }
  });

  it('does not run the probe after unknown, malformed or oversized filter discovery', () => {
    for (const result of [
      { stdout: '', stderr: 'unknown', status: 128 },
      { stdout: 'not-a-filter\ncommand\0', stderr: '', status: 0 },
      { stdout: 'filter.x.clean\ncmd\0'.repeat(4097), stderr: '', status: 0 },
    ]) {
      const exec = vi.spyOn(io, 'safeExecResult').mockReturnValue(result);
      expect(() => runHardenedGitProbe(['ls-files', '-s', '-z'])).toThrow('GIT_PROBE_UNAVAILABLE');
      expect(exec).toHaveBeenCalledTimes(1);
      exec.mockRestore();
    }
  });

  it('overrides ambient config injection and retains an explicitly private index', () => {
    const exec = vi
      .spyOn(io, 'safeExecResult')
      .mockReturnValue({ stdout: '', stderr: '', status: 1 });
    runHardenedGitProbe(['ls-files', '-s', '-z'], {
      env: {
        GIT_CONFIG_COUNT: '999',
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'",
        GIT_INDEX_FILE: '/private-index',
      },
    });
    const env = exec.mock.calls.at(-1)![2]!.env!;
    expect(env.GIT_CONFIG_COUNT).not.toBe('999');
    expect(env.GIT_CONFIG_PARAMETERS).toBe('');
    expect(env.GIT_INDEX_FILE).toBe('/private-index');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it.skipIf(process.platform === 'win32')(
    'neutralizes repo fsmonitor, named clean/process and diff/textconv executables in an isolated checkout',
    () => {
      const root = pathResolver.sharedTmp(`vitest-git-probe-${randomUUID()}`);
      roots.push(root);
      io.safeMkdir(root, { recursive: true });
      git(root, ['init', '-q']);
      io.safeWriteFile(path.join(root, 'file.txt'), 'original\n');
      git(root, ['add', 'file.txt']);
      git(root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'original',
      ]);
      const before = git(root, ['rev-parse', 'HEAD']).trim();
      io.safeWriteFile(path.join(root, 'file.txt'), 'changed tree\n');
      git(root, ['add', 'file.txt']);
      git(root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'changed',
      ]);
      const head = git(root, ['rev-parse', 'HEAD']).trim();
      const marker = path.join(root, 'SENTINEL');
      const payload = path.join(root, 'sentinel.cjs');
      io.safeWriteFile(
        payload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'fired');`
      );
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
      const command = `${quote(process.execPath)} ${quote(payload)}`;
      for (const key of [
        'core.fsmonitor',
        'filter.evil.clean',
        'filter.evil.smudge',
        'filter.evil.process',
        'diff.evil.command',
        'diff.evil.textconv',
      ])
        git(root, ['config', key, command]);
      git(root, ['config', 'filter.evil.required', 'true']);
      io.safeWriteFile(path.join(root, '.gitattributes'), '*.txt filter=evil diff=evil\n');
      io.safeWriteFile(path.join(root, 'file.txt'), 'modified\n');
      // Simulate a new filter appearing AFTER discovery. Closed probe forms
      // remain object/index-only rather than treating discovery as a fence.
      const execute = io.safeExecResult;
      vi.spyOn(io, 'safeExecResult').mockImplementation((bin, args, options) => {
        const result = execute(bin, args, options);
        if (bin === 'git' && args?.[0] === 'config' && args.includes('--includes')) {
          execute('git', ['config', 'filter.late.process', command], { cwd: root });
          io.safeWriteFile(path.join(root, '.gitattributes'), '*.txt filter=late diff=evil\n');
        }
        return result;
      });
      expect(runHardenedGitProbe(['ls-files', '-s', '-z'], { cwd: root }).status).toBe(0);
      expect(
        runHardenedGitProbe(['diff-tree', '-r', '-z', '--no-renames', before, head], { cwd: root })
          .status
      ).toBe(0);
      expect(() => runHardenedGitProbe(['status', '--porcelain'], { cwd: root })).toThrow(
        'GIT_PROBE_UNAVAILABLE'
      );
      expect(io.safeExistsSync(marker)).toBe(false);
    }
  );
});
