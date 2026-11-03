import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeWriteFile, safeReadFile, safeExecResult, safeRmSync } from '../secure-io.js';

const original = process.cwd();
const root = path.join(original, 'active/shared/tmp', `offline-clone-${randomUUID()}`);
let sha = '';
let offMain = '';
let engine: typeof import('./mission-development-git.js');
let io: typeof import('../secure-io.js');
let authority: typeof import('../authority.js');
let workspace: typeof import('./mission-development-workspace.js');
let ledger: typeof import('../workforce/workspace-ledger.js');
function git(args: string[], cwd = root) {
  const result = safeExecResult('git', args, { cwd });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || 'Fixture Git failed');
  return result.stdout.trim();
}
beforeAll(async () => {
  seedFirstJobTestRoot(original, root);
  const manifest = 'libs/actuators/vcs-actuator/manifest.json';
  safeWriteFile(path.join(root, manifest), safeReadFile(path.join(original, manifest)), {
    mkdir: true,
  });
  safeWriteFile(path.join(root, 'libs/core/example.ts'), 'export const value = 1;', {
    mkdir: true,
  });
  safeWriteFile(path.join(root, '.gitattributes'), '*.ts filter=poison\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['add', 'libs/core/example.ts', '.gitattributes']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed']);
  sha = git(['rev-parse', 'HEAD']);
  offMain = git(['commit-tree', `${sha}^{tree}`, '-p', sha, '-m', 'unreachable from main']);
  // A source-local filter must never become executable target configuration.
  git(['config', 'filter.poison.smudge', 'false']);
  git(['config', 'filter.poison.required', 'true']);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const name of ['SYSTEM_ROLE', 'MISSION_ID', 'KYBERION_TENANT', 'KYBERION_SUDO'])
    vi.stubEnv(name, '');
  vi.stubEnv('KYBERION_TIER', 'public');
  vi.resetModules();
  engine = await import('./mission-development-git.js');
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  workspace = await import('./mission-development-workspace.js');
  ledger = await import('../workforce/workspace-ledger.js');
}, 60_000);
afterAll(() => {
  process.chdir(original);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  safeRmSync(root, { recursive: true, force: true });
});
describe('reviewed offline source clone', () => {
  it('rejects invalid, absent and off-main baselines before registration or workspace creation', async () => {
    await authority.withExecutionContextAsync('mission_controller', async () => {
      const before = ledger.listWorkspaces();
      for (const [index, baseline] of ['main', 'a'.repeat(40), offMain].entries()) {
        const state = { mission_id: `MSN-INVALID-BASELINE-${index}`, tier: 'public' as const };
        const name =
          'development-' +
          createHash('sha256')
            .update(JSON.stringify([state.mission_id, 'implement']))
            .digest('hex')
            .slice(0, 16);
        const target = path.join(
          root,
          'active/shared/runtime/workspaces/public/shared/development',
          name
        );
        expect(() =>
          workspace.ensureMissionDevelopmentSourceWorkspace(
            state,
            'implement',
            ['libs/core/example.ts'],
            () => {},
            { localBaselineCommit: baseline }
          )
        ).toThrow();
        expect(ledger.listWorkspaces()).toEqual(before);
        expect(io.safeExistsSync(target)).toBe(false);
      }
    });
  });
  it('rolls back ledger registration when offline clone fails after allocate', async () => {
    await authority.withExecutionContextAsync('mission_controller', async () => {
      const before = ledger.listWorkspaces();
      const state = { mission_id: 'MSN-CLONE-FAIL', tier: 'public' as const };
      const execute = io.safeExecResult;
      const spy = vi.spyOn(io, 'safeExecResult').mockImplementation((command, args, options) => {
        if (args[0] === 'clone') {
          return {
            status: 1,
            stdout: '',
            stderr: 'clone failed',
            error: new Error('clone failed'),
          } as ReturnType<typeof execute>;
        }
        return execute(command, args, options);
      });
      expect(() =>
        workspace.ensureMissionDevelopmentSourceWorkspace(
          state,
          'implement',
          ['libs/core/example.ts'],
          () => {},
          { localBaselineCommit: sha }
        )
      ).toThrow(/Private repository setup failed|clone failed/i);
      expect(ledger.listWorkspaces()).toEqual(before);
      spy.mockRestore();
    });
  });
  it('copies only committed source with independent Git objects and no remote or network operation', async () => {
    const calls: string[][] = [];
    const execute = io.safeExecResult;
    const spy = vi.spyOn(io, 'safeExecResult').mockImplementation((command, args, options) => {
      calls.push([...args]);
      if (args.includes('fetch')) throw new Error('Network fetch forbidden');
      return execute(command, args, options);
    });
    const target = path.join(root, 'active/shared/tmp/clone');
    await authority.withExecutionContextAsync('mission_controller', async () => {
      engine.cloneIsolatedDevelopmentRepository(root, target, '', () => {}, {
        localBaselineCommit: sha,
      });
      expect(git(['rev-parse', 'HEAD'], target)).toBe(sha);
      expect(git(['remote'], target)).toBe('');
      expect(
        io.safeExecResult('git', ['config', '--get', 'filter.poison.smudge'], { cwd: target })
          .status
      ).toBe(1);
      expect(io.safeLstat(path.join(target, '.git')).isDirectory()).toBe(true);
      expect(io.safeExistsSync(path.join(target, '.git/objects/info/alternates'))).toBe(false);
      expect(io.safeExistsSync(path.join(target, 'knowledge/personal'))).toBe(false);
      expect(io.safeExistsSync(path.join(target, 'libs/actuators'))).toBe(false);
      expect(calls.some((args) => args.includes('--no-hardlinks'))).toBe(true);
      io.safeWriteFile(path.join(target, 'libs/core/example.ts'), 'export const value = 2;');
      git(['add', 'libs/core/example.ts'], target);
      git(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'private change',
        ],
        target
      );
      const privateHead = git(['rev-parse', 'HEAD'], target);
      expect(
        io.safeExecResult('git', ['cat-file', '-e', privateHead], { cwd: root }).status
      ).not.toBe(0);
    });
    spy.mockRestore();
  });
  it('rejects mutable and missing baseline references before creating a checkout', async () => {
    await authority.withExecutionContextAsync('mission_controller', async () => {
      for (const value of ['main', 'HEAD', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(40)]) {
        const target = path.join(root, 'active/shared/tmp/rejected');
        expect(() =>
          engine.cloneIsolatedDevelopmentRepository(root, target, '', () => {}, {
            localBaselineCommit: value,
          })
        ).toThrow();
        expect(io.safeExistsSync(target)).toBe(false);
      }
    });
  });
  it('refuses a lost owner scope before any Git operation', async () => {
    const spy = vi.spyOn(io, 'safeExecResult');
    const target = path.join(root, 'active/shared/tmp/stale');
    await authority.withExecutionContextAsync('mission_controller', async () => {
      expect(() =>
        engine.cloneIsolatedDevelopmentRepository(
          root,
          target,
          '',
          () => {
            throw new Error('lease lost');
          },
          { localBaselineCommit: sha }
        )
      ).toThrow('lease lost');
    });
    expect(spy).not.toHaveBeenCalled();
    expect(io.safeExistsSync(target)).toBe(false);
    spy.mockRestore();
  });
  it('refuses changed baselines or configured remotes on workspace reuse', async () => {
    await authority.withExecutionContextAsync('mission_controller', async () => {
      const state = { mission_id: 'MSN-OFFLINE-FIXTURE', tier: 'public' as const };
      const prepare = () =>
        workspace.ensureMissionDevelopmentSourceWorkspace(
          state,
          'implement',
          ['libs/core/example.ts'],
          () => {},
          { localBaselineCommit: sha }
        )!;
      const allocated = prepare();
      expect(prepare()).toMatchObject({ cwd: allocated.cwd, created: false });
      const execute = io.safeExecResult;
      let hardenedCommonProbe = false;
      const spy = vi.spyOn(io, 'safeExecResult').mockImplementation((command, args, options) => {
        if (args.includes('--git-common-dir')) {
          expect(options?.env).toMatchObject({
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
          });
          expect(options?.env).toHaveProperty('GIT_DIR', undefined);
          expect(options?.env).toHaveProperty('GIT_COMMON_DIR', undefined);
          expect(options?.env).toHaveProperty('GIT_OBJECT_DIRECTORY', undefined);
          hardenedCommonProbe = true;
        }
        return execute(command, args, options);
      });
      expect(prepare()).toMatchObject({ cwd: allocated.cwd, created: false });
      expect(hardenedCommonProbe).toBe(true);
      spy.mockRestore();
      git(['remote', 'add', 'origin', 'https://example.invalid/not-authorized'], allocated.cwd);
      expect(prepare).toThrow('baseline or remote configuration changed');
      git(['remote', 'remove', 'origin'], allocated.cwd);
      git(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-qm',
          'unexpected commit',
        ],
        allocated.cwd
      );
      expect(prepare).toThrow('baseline or remote configuration changed');
    });
  });
  it('preserves read-only development proof reuse without invoking its allocation callback', async () => {
    await authority.withExecutionContextAsync('mission_controller', async () => {
      const state = { mission_id: 'MSN-READONLY-FIXTURE', tier: 'public' as const };
      const allocated = workspace.ensureMissionDevelopmentSourceWorkspace(
        state,
        'implement',
        ['libs/core/example.ts'],
        () => {},
        { localBaselineCommit: sha }
      )!;
      const cannotAllocate = vi.fn(() => {
        throw new Error('Read-only development gate cannot allocate a workspace');
      });
      expect(
        workspace.ensureMissionDevelopmentSourceWorkspace(
          state,
          'implement',
          ['libs/core/example.ts'],
          cannotAllocate,
          { create: false }
        )
      ).toMatchObject({ cwd: allocated.cwd, created: false });
      expect(cannotAllocate).not.toHaveBeenCalled();
    });
  });
});
