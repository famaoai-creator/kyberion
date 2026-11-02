import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  tier: 'public',
  tenant: undefined as string | undefined,
  organization: undefined as string | undefined,
  project: undefined as string | undefined,
  mission: undefined as string | undefined,
  envelope: undefined as unknown,
  records: [] as Array<{
    path: string;
    live: boolean;
    owner: { mission_id: string; task_id: string };
    tier: string;
  }>,
}));
vi.mock('../scope-context.js', () => ({
  resolveScopeContext: () => ({
    tier: state.tier,
    tenant_slug: state.tenant,
    organization_id: state.organization,
    project_id: state.project,
    mission_id: state.mission,
  }),
}));
vi.mock('../workforce/workspace-ledger.js', async (original) => ({
  ...(await original<typeof import('../workforce/workspace-ledger.js')>()),
  listWorkspaces: () => state.records,
  workspaceOwnerScope: (owner: { mission_id: string }) => ({
    owner: { kind: 'mission', id: owner.mission_id },
    tier: state.records.find((r) => r.owner === owner)?.tier,
    tenant: state.records.find((r) => r.owner === owner)?.tier === 'personal' ? 'shared' : 'acme',
    organization_id: 'org-a',
    project_id: 'project-a',
  }),
}));
vi.mock('../scope-envelope.js', () => ({
  currentScopeEnvelope: () => state.envelope,
  runtimeScopeIdentity: () => ({
    tier: state.tier,
    tenant_slug: state.tenant,
    organization_id: state.organization,
    project_id: state.project,
    mission_id: state.mission,
  }),
}));
import { pathResolver } from '../path-resolver.js';
import * as paths from '../path-resolver.js';
import { safeMkdir, safeWriteFile, safeSymlinkSync, safeRmSync } from '../secure-io.js';
import { withExecutionContext, resetRoleAssumptionPolicyCache } from '../authority.js';
import { gitLog, gitPush } from './git.js';
import { ghPrView, ghPrMerge } from './github.js';
import { assertVcsCwdScope } from './cwd-scope.js';

const sourceRoot = pathResolver.rootDir();
let root: string;
let personal: string;
let confidential: string;
beforeEach(() => {
  root = path.join(sourceRoot, 'active/shared/tmp/vitest-vcs-cwd', randomUUID());
  personal = path.join(root, 'active/shared/runtime/workspaces/personal/shared/code');
  confidential = path.join(root, 'active/shared/runtime/workspaces/confidential/acme/code');
  for (const folder of [personal, confidential, path.join(root, 'knowledge/personal/tenants')])
    safeMkdir(folder, { recursive: true });
  safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/acme.json'),
    JSON.stringify({
      tenant_slug: 'acme',
      status: 'active',
      assigned_role: 'owner',
      display_name: 'Fixture',
    })
  );
  safeSymlinkSync(
    personal,
    path.join(root, 'public-alias'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  vi.spyOn(pathResolver, 'rootDir').mockReturnValue(root);
  vi.spyOn(paths, 'rootDir').mockReturnValue(root);
  vi.spyOn(pathResolver, 'rootResolve').mockImplementation((value) => path.resolve(root, value));
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
  vi.stubEnv('KYBERION_TENANT', '');
  resetRoleAssumptionPolicyCache();
  state.tier = 'public';
  state.tenant = undefined;
  state.organization = undefined;
  state.project = undefined;
  state.mission = undefined;
  state.envelope = undefined;
  state.records = [personal, confidential].map((location) => ({
    path: location,
    live: true,
    owner: { mission_id: 'MSN-CWD', task_id: 'source-task' },
    tier: location === personal ? 'personal' : 'confidential',
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRoleAssumptionPolicyCache();
  safeRmSync(root, { recursive: true, force: true });
});

describe('typed VCS repository data scope', () => {
  it.each(['git-read', 'git-push', 'gh-read', 'gh-merge'])(
    'blocks public %s on private cwd before even an injected transport runs',
    (operation) => {
      const run = vi.fn(() => ({ status: 0, stdout: '{}', stderr: '' }));
      const action = () =>
        operation === 'git-read'
          ? gitLog(personal, {}, run)
          : operation === 'git-push'
            ? gitPush(personal, {}, run)
            : operation === 'gh-read'
              ? ghPrView({ cwd: personal, ref: '1', fields: 'number' }, run)
              : ghPrMerge({ cwd: personal, ref: '1' }, run);
      expect(() => withExecutionContext('mission_controller', action, 'sovereign')).toThrow(
        'VCS_CWD_SCOPE_DENIED'
      );
      expect(run).not.toHaveBeenCalled();
    }
  );
  it('rejects a public symlink alias before lexical public classification', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'secret', stderr: '' }));
    expect(() => gitLog(path.join(root, 'public-alias'), {}, run)).toThrow('RESOURCE_PATH_SYMLINK');
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['personal', 'confidential'] as const)(
    'allows an actually permitted own %s cwd',
    (tier) => {
      state.tier = tier;
      state.tenant = tier === 'confidential' ? 'acme' : undefined;
      const run = vi.fn(() => ({ status: 0, stdout: 'own repository', stderr: '' }));
      expect(
        withExecutionContext(
          'mission_controller',
          () => gitLog(tier === 'personal' ? personal : confidential, {}, run),
          'ecosystem_architect',
          state.tenant
        ).stdout
      ).toBe('own repository');
      expect(run).toHaveBeenCalledOnce();
    }
  );
  it('does not equate personal rank with confidential tenant membership', () => {
    state.tier = 'personal';
    expect(() => assertVcsCwdScope(confidential)).toThrow('VCS_CWD_SCOPE_DENIED');
    state.tier = 'confidential';
    state.tenant = 'other';
    expect(() => assertVcsCwdScope(confidential)).toThrow('VCS_CWD_SCOPE_DENIED');
    state.tenant = 'acme';
    expect(() => assertVcsCwdScope(personal)).toThrow('VCS_CWD_SCOPE_DENIED');
  });
  it('honors explicit read ceilings and refuses unknown runtime scope', () => {
    state.envelope = { identity: { tier: 'personal' }, policy: { read_tiers: ['public'] } };
    expect(() => assertVcsCwdScope(personal)).toThrow('VCS_CWD_SCOPE_DENIED');
    state.envelope = undefined;
    state.tier = 'invented';
    expect(() => assertVcsCwdScope(root)).toThrow('VCS_CWD_SCOPE_DENIED');
  });
  it('rejects same-tenant foreign project, organization, mission and stale workspace', () => {
    state.tier = 'confidential';
    state.tenant = 'acme';
    state.project = 'foreign';
    expect(() => assertVcsCwdScope(confidential)).toThrow('VCS_CWD_SCOPE_DENIED');
    state.project = 'project-a';
    state.organization = 'foreign';
    expect(() => assertVcsCwdScope(confidential)).toThrow('VCS_CWD_SCOPE_DENIED');
    state.organization = 'org-a';
    state.mission = 'MSN-FOREIGN';
    expect(() => assertVcsCwdScope(confidential)).toThrow('VCS_CWD_SCOPE_DENIED');
    state.mission = 'MSN-CWD';
    state.records[1].live = false;
    expect(() => assertVcsCwdScope(confidential)).toThrow('VCS_CWD_SCOPE_DENIED');
  });
});
