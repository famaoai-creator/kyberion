import { pathResolver } from '../path-resolver.js';
import { resolveScopeResolution } from '../scope-context.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { missionControllerStartInput } from './mission-controller-start-input.js';

describe('mission controller start handoff', () => {
  const input = {
    missionId: 'MSN-TEST-HANDOFF',
    tier: 'confidential',
    orgRole: 'ecosystem_architect',
    missionType: 'operations_report',
    scope: { tenant_slug: 'tenant-a', organization_id: 'org-a', project_id: 'project-a' },
  } as const;

  it('passes named scope fields and clears ambient parent state', () => {
    const { args, env } = missionControllerStartInput(input);
    expect(args).toEqual([
      'start',
      'MSN-TEST-HANDOFF',
      '--tier',
      'confidential',
      '--org-role',
      'ecosystem_architect',
      '--mission-type',
      'operations_report',
      '--tenant-slug',
      'tenant-a',
      '--organization-id',
      'org-a',
      '--project-id',
      'project-a',
    ]);
    expect(env).toMatchObject({
      KYBERION_TENANT: 'tenant-a',
      KYBERION_ORGANIZATION_ID: 'org-a',
      KYBERION_PROJECT_ID: 'project-a',
      KYBERION_STANCE: '',
      MISSION_ID: '',
      TASK_ID: '',
    });
  });

  it('passes a shared public project without inheriting a tenant', () => {
    const { args, env } = missionControllerStartInput({
      ...input,
      tier: 'public',
      scope: { project_id: 'public-project' },
    });
    expect(args.slice(-2)).toEqual(['--project-id', 'public-project']);
    expect(args).not.toContain('--tenant-slug');
    expect(env).toMatchObject({ KYBERION_TENANT: '', KYBERION_PROJECT_ID: 'public-project' });
  });

  it('ignores persisted tenant and organization for a scoped child', () => {
    const scopeEnv = pathResolver.sharedTmp('mission-handoff-parent-scope.env');
    safeWriteFile(scopeEnv, 'KYBERION_TENANT=tenant-parent\nKYBERION_ORGANIZATION_ID=org-parent\n');
    try {
      const parentEnv = { KYBERION_SCOPE_ENV_PATH: scopeEnv };
      const options = { inferFromMission: false, inferFromCwd: false };
      expect(resolveScopeResolution({}, parentEnv, options).scope.tenant_slug).toBe(
        'tenant-parent'
      );
      const { env } = missionControllerStartInput({
        ...input,
        tier: 'public',
        scope: { project_id: 'public-project' },
      });
      const child = resolveScopeResolution({}, { ...parentEnv, ...env }, options).scope;
      expect(child).toMatchObject({ tier: 'public', project_id: 'public-project' });
      expect(child.tenant_slug).toBeUndefined();
      expect(child.organization_id).toBeUndefined();
    } finally {
      safeRmSync(scopeEnv, { force: true });
    }
  });

  it('rejects a role which would be parsed as a controller switch', () => {
    expect(() => missionControllerStartInput({ ...input, orgRole: '--force' })).toThrow(
      'must be identifiers'
    );
  });

  it('does not replace a bound or explicitly cleared tenant', () => {
    for (const tenant of ['tenant-b', '']) {
      withExecutionContext(
        'mission_controller',
        () => {
          expect(() => missionControllerStartInput(input)).toThrow('current execution binding');
        },
        undefined,
        tenant
      );
    }
  });
});
