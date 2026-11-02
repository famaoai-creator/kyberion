/** Actual isolated private repository; all Git state and policy data are inside a disposable root. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import {
  safeWriteFile as outerWrite,
  safeRmSync as outerRemove,
  safeExecResult as outerExec,
  safeReadFile as outerRead,
} from '../secure-io.js';
import type { MissionState } from './mission-types.js';
const original = process.cwd();
const root = path.join(
  original,
  'active/shared/tmp',
  `private-development-worktree-${randomUUID()}`
);
let workspace: typeof import('./mission-development-workspace.js');
let ledger: typeof import('../workforce/workspace-ledger.js');
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');
let resolver: typeof import('../path-resolver.js');
let sourceTools: typeof import('../workforce/task-source-edit.js');
let ownerGit: typeof import('./mission-development-git.js');
const upstream = path.join(root, 'active/shared/tmp/upstream.git');
let upstreamHead = '';
function git(args: string[]) {
  const result = outerExec('git', args, { cwd: root });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || 'Fixture git failed');
  return result.stdout.trim();
}
beforeAll(async () => {
  seedFirstJobTestRoot(original, root);
  const vcsManifest = 'libs/actuators/vcs-actuator/manifest.json';
  outerWrite(path.join(root, vcsManifest), outerRead(path.join(original, vcsManifest)), {
    mkdir: true,
  });
  outerWrite(path.join(root, '.gitignore'), 'active/\nknowledge/personal/\n');
  outerWrite(path.join(root, 'libs/core/example.ts'), 'export const example = 1;\n', {
    mkdir: true,
  });
  outerWrite(
    path.join(root, 'knowledge/personal/tenants/acme.json'),
    JSON.stringify({
      tenant_slug: 'acme',
      display_name: 'Fixture',
      status: 'active',
      assigned_role: 'owner',
    }),
    { mkdir: true }
  );
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', 'package.json', '.gitignore', 'libs/core/example.ts']);
  git(['add', '-f', 'knowledge/product/governance/security-policy.json']);
  git(['commit', '-qm', 'seed']);
  // The runtime's local main deliberately lags the actual destination main.
  const staleMain = git(['rev-parse', 'HEAD']);
  git(['clone', '--bare', root, upstream]);
  outerWrite(path.join(root, 'libs/core/upstream.ts'), 'export const upstream = true;\n');
  git(['add', 'libs/core/upstream.ts']);
  git(['commit', '-qm', 'advance upstream main']);
  upstreamHead = git(['rev-parse', 'HEAD']);
  git(['push', upstream, 'HEAD:refs/heads/main']);
  git(['reset', '--hard', staleMain]);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const name of [
    'MISSION_ID',
    'SYSTEM_ROLE',
    'KYBERION_TENANT',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_PROJECT_ID',
    'KYBERION_TASK_ID',
    'KYBERION_SUDO',
    'KYBERION_CUSTOMER',
  ])
    vi.stubEnv(name, '');
  vi.stubEnv('KYBERION_DELEGATION_DEPTH', '0');
  vi.resetModules();
  authority = await import('../authority.js');
  io = await import('../secure-io.js');
  resolver = await import('../path-resolver.js');
  sourceTools = await import('../workforce/task-source-edit.js');
  ownerGit = await import('./mission-development-git.js');
  workspace = await import('./mission-development-workspace.js');
  ledger = await import('../workforce/workspace-ledger.js');
  // Substitute only external transport; clone, fetch objects and checkout are
  // real Git, including the canonical typed boundary and closed fetch runner.
  const execute = io.safeExecResult;
  vi.spyOn(io, 'safeExecResult').mockImplementation((command, args, options) => {
    if (command === 'git' && args.includes('fetch')) {
      expect(args.slice(-3)).toEqual([
        'fetch',
        'https://github.com/fixture/private-repo',
        'refs/heads/main',
      ]);
      expect(args).toContain('protocol.https.allow=always');
      return execute(
        command,
        [
          '-c',
          'protocol.file.allow=always',
          ...args.map((arg) =>
            arg === 'https://github.com/fixture/private-repo' ? upstream : arg
          ),
        ],
        options
      );
    }
    return execute(command, args, options);
  });
}, 60000);
afterAll(() => {
  process.chdir(original);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  outerRemove(root, { recursive: true, force: true });
});
describe('private owner workspace allocation with real Git and policy', () => {
  it.each(['public', 'personal', 'confidential'] as const)(
    'allocates/reuses a protected isolated %s repository with exact task ownership',
    async (tier) => {
      vi.stubEnv('KYBERION_TIER', tier);
      vi.stubEnv('KYBERION_TENANT', tier === 'confidential' ? 'acme' : '');
      const state: MissionState = {
        mission_id: `MSN-PRIVATE-WORKSPACE-${tier.toUpperCase()}`,
        tier,
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'tester',
        confidence_score: 1,
        git: {
          branch: 'main',
          start_commit: git(['rev-parse', 'HEAD']),
          latest_commit: git(['rev-parse', 'HEAD']),
          checkpoints: [],
        },
        history: [],
        ...(tier === 'confidential' ? { tenant_slug: 'acme' } : {}),
      };
      await authority.withExecutionContextAsync('mission_controller', async () => {
        const policyPath = 'knowledge/product/governance/security-policy.json';
        const originalPolicy = String(io.safeReadFile(path.join(root, policyPath)));
        const sourcePaths = ['libs/core/example.ts', ...(tier === 'public' ? [policyPath] : [])];
        const mission =
          tier === 'confidential'
            ? resolver.tenantMissionDir(state.mission_id, 'acme', tier)
            : resolver.missionDir(state.mission_id, tier);
        io.safeMkdir(mission, { recursive: true });
        io.safeWriteFile(path.join(mission, 'mission-state.json'), JSON.stringify(state));
        const allocated = workspace.ensureMissionDevelopmentSourceWorkspace(
          state,
          'implementation',
          sourcePaths,
          () => {},
          { repositoryUrl: 'https://github.com/fixture/private-repo' }
        );
        expect(allocated?.created).toBe(true);
        expect(
          io.safeExecResult('git', ['rev-parse', 'HEAD'], { cwd: allocated!.cwd }).stdout.trim()
        ).toBe(upstreamHead);
        expect(
          String(io.safeReadFile(path.join(allocated!.cwd, 'libs/core/upstream.ts')))
        ).toContain('upstream = true');
        expect(io.safeExistsSync(path.join(root, 'libs/core/upstream.ts'))).toBe(false);
        expect(allocated?.cwd).toContain(
          `active/shared/runtime/workspaces/${tier}/${tier === 'confidential' ? 'acme' : 'shared'}/development/`
        );
        expect(
          ledger.listWorkspaces().find((record) => record.path === allocated?.cwd)?.owner
        ).toMatchObject({ mission_id: state.mission_id, task_id: 'implementation' });
        expect(
          workspace.ensureMissionDevelopmentSourceWorkspace(
            state,
            'implementation',
            sourcePaths,
            () => {}
          )
        ).toMatchObject({ cwd: allocated?.cwd, created: false });
        expect(
          String(io.safeReadFile(path.join(allocated!.cwd, 'libs/core/example.ts')))
        ).toContain('export const example');
        const prepare = (commit: boolean) =>
          workspace.prepareMissionDevelopmentWorkspace(
            {
              cwd: allocated!.cwd,
              sourcePaths,
              owned: true,
              commit,
              taskId: 'implementation',
              assertCurrent: () => {},
              reserve: () => {},
            },
            (command, args, options) => {
              const executed = ownerGit.createDevelopmentWorkspaceGitRunner(
                allocated!.cwd,
                sourcePaths,
                'implementation'
              )(command, args, options);
              if (executed.status !== 0 && args[0] !== 'show-ref')
                throw new Error(
                  `${JSON.stringify(args)}: ${executed.error?.message || executed.stderr || 'Fixture owner Git failed'}`
                );
              return executed;
            },
            allocated!.cwd
          );
        expect(prepare(false)).toBe('advanced');
        const binding = {
          scope: {
            scope_kind: 'task' as const,
            tier,
            mission_id: state.mission_id,
            task_id: 'implementation',
            ...(tier === 'confidential' ? { tenant_slug: 'acme' } : {}),
          },
          actorId: 'fixture-worker',
          workItemId: 'fixture-item',
          taskId: 'implementation',
          missionId: state.mission_id,
          leaseId: 'fixture-lease',
          capabilityProfile: 'implementer',
          readRoots: [],
          writeRoots: [],
        };
        const edit = sourceTools.createTaskSourceEditTool(binding, allocated!.sourcePaths, {
          requiresApproval: false,
          assertCurrent: () => {},
        });
        await edit.execute(
          {
            path: allocated!.sourcePaths[0],
            content: 'export const example = "private generated code";\n',
          },
          binding
        );
        if (tier === 'public') {
          expect(git(['ls-files', policyPath])).toContain(policyPath);
          expect(
            io.safeExecResult('git', ['ls-files', policyPath], { cwd: allocated!.cwd }).stdout
          ).toContain(policyPath);
          await edit.execute(
            {
              path: allocated!.sourcePaths[1],
              content: '{"proposal_only":"not active authority"}\n',
            },
            binding
          );
          expect(String(io.safeReadFile(path.join(root, policyPath)))).toBe(originalPolicy);
          expect(String(io.safeReadFile(path.join(allocated!.cwd, policyPath)))).toContain(
            'proposal_only'
          );
        }
        expect(prepare(true)).toBe('advanced');
        const privateHead = io
          .safeExecResult('git', ['rev-parse', 'HEAD'], { cwd: allocated!.cwd })
          .stdout.trim();
        expect(
          io.safeExecResult('git', ['cat-file', '-e', privateHead], { cwd: root }).status
        ).not.toBe(0);
        if (tier !== 'public') {
          vi.stubEnv('KYBERION_TIER', 'public');
          expect(() =>
            ownerGit.createDevelopmentWorkspaceGitRunner(
              allocated!.cwd,
              sourcePaths,
              'implementation'
            )('git', ['rev-parse', 'HEAD'], { cwd: allocated!.cwd })
          ).toThrow('VCS_CWD_SCOPE_DENIED');
          vi.stubEnv('KYBERION_TIER', tier);
        }
        expect(
          io
            .safeExecResult('git', ['remote', 'get-url', 'origin'], { cwd: allocated!.cwd })
            .stdout.trim()
        ).toBe('https://github.com/fixture/private-repo');
      });
      // Fixture-only cleanup: no live mission or repository is touched.
      expect(git(['branch', '--show-current'])).toBe('main');
    }
  );
});
