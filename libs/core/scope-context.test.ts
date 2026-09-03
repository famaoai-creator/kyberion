import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  assertScopeContext,
  currentScope,
  normalizeScopeContext,
  resetCurrentScope,
  resolveScopeResolution,
  resolveScopeContext,
  scopeContextKey,
  validateScopeContext,
  writeScopeEnv,
  clearScopeEnv,
} from './scope-context.js';

describe('scope-context', () => {
  it('keeps customer stance separate from tenant scope', () => {
    const context = resolveScopeContext(
      { tier: 'confidential', customer_stance: 'kyberion-development-team' },
      { KYBERION_CUSTOMER: 'kyberion-development-team' }
    );
    expect(context.customer_stance).toBe('kyberion-development-team');
    expect(context.tenant_slug).toBeUndefined();
    expect(validateScopeContext(context)).toContain('tenant_slug is required for this scope');
  });

  it('normalizes tenant_id only as a compatibility input', () => {
    expect(normalizeScopeContext({ tenant_id: 'acme-corp', tier: 'confidential' })).toEqual({
      tenant_slug: 'acme-corp',
      tier: 'confidential',
    });
  });

  it('rejects conflicting aliases and broken parent chains', () => {
    expect(() =>
      normalizeScopeContext({
        tenant_slug: 'acme-corp',
        tenant_id: 'beta-corp',
        tier: 'confidential',
      })
    ).toThrow('conflicts');
    expect(
      validateScopeContext({ tenant_slug: 'acme-corp', project_id: 'PRJ-1', tier: 'confidential' })
    ).toContain('project_id requires an organization_id');
  });

  it('requires tenant scope for confidential data and permits public shared context', () => {
    expect(() => assertScopeContext({ tier: 'confidential' })).toThrow('[SCOPE_CONTEXT_INVALID]');
    expect(assertScopeContext({ tier: 'public' })).toEqual({ tier: 'public' });
  });

  it('produces a stable containment key', () => {
    expect(
      scopeContextKey({
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        organization_id: 'org-a',
        mission_id: 'MSN-1',
      })
    ).toBe('acme-corp/org-a/_/MSN-1/_/_/confidential');
  });

  it('resolves project and task from the runtime environment', () => {
    expect(
      resolveScopeContext(
        { tier: 'confidential', tenant_slug: 'acme-corp' },
        {
          KYBERION_ORGANIZATION_ID: 'org-a',
          KYBERION_PROJECT_ID: 'project-a',
          MISSION_ID: 'mission-a',
          KYBERION_TASK_ID: 'task-a',
        }
      )
    ).toMatchObject({
      organization_id: 'org-a',
      project_id: 'project-a',
      mission_id: 'mission-a',
      task_id: 'task-a',
    });
  });

  it('reports deterministic provenance and roots for a tenant scope', () => {
    const resolution = resolveScopeResolution(
      { tier: 'confidential', tenant_slug: 'acme-corp' },
      { KYBERION_ORGANIZATION_ID: 'org-a', KYBERION_PROJECT_ID: 'project-a' }
    );
    expect(resolution.scope).toMatchObject({
      tier: 'confidential',
      tenant_slug: 'acme-corp',
      organization_id: 'org-a',
      project_id: 'project-a',
    });
    expect(resolution.provenance).toMatchObject({
      tier: 'explicit',
      tenant_slug: 'explicit',
      organization_id: 'env',
      project_id: 'env',
    });
    expect(resolution.knowledge_roots).toContain(
      'confidential/acme-corp/organizations/org-a/projects/project-a'
    );
    expect(resolution.knowledge_roots).not.toContain('confidential');
  });

  it('uses the mission tier before the public default', () => {
    const missionDir = pathResolver.shared('tmp/scope-context-mission-tier-test');
    safeMkdir(missionDir, { recursive: true });
    safeWriteFile(
      pathResolver.rootResolve(`${pathResolver.toRepoRelative(missionDir)}/mission-state.json`),
      JSON.stringify({
        mission_id: 'mission-tier-test',
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'test',
        confidence_score: 1,
        git: {
          branch: 'main',
          start_commit: 'deadbeef',
          latest_commit: 'deadbeef',
          checkpoints: [],
        },
        history: [],
      })
    );
    const findMissionPath = vi.spyOn(pathResolver, 'findMissionPath').mockReturnValue(missionDir);
    try {
      const resolution = resolveScopeResolution(
        { mission_id: 'mission-tier-test' },
        {},
        { includePersisted: false, inferFromCwd: false }
      );
      expect(resolution.scope).toMatchObject({
        tier: 'confidential',
        tenant_slug: 'acme-corp',
      });
      expect(resolution.provenance.tier).toBe('mission-state');
    } finally {
      findMissionPath.mockRestore();
      safeRmSync(missionDir, { recursive: true, force: true });
    }
  });

  it('round-trips the governed scope.env file', () => {
    const env = { KYBERION_SCOPE_ENV_PATH: 'active/shared/tmp/scope-context-test.env' };
    clearScopeEnv(env);
    writeScopeEnv(
      {
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        organization_id: 'org-a',
        project_id: 'project-a',
      },
      env
    );
    try {
      expect(resolveScopeResolution({}, env).scope).toMatchObject({
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        organization_id: 'org-a',
        project_id: 'project-a',
      });
      expect(resolveScopeResolution({}, env).provenance.tenant_slug).toBe('scope.env');
    } finally {
      clearScopeEnv(env);
    }
  });

  it('rejects a scope.env path outside the repository root', () => {
    expect(() =>
      writeScopeEnv({ tier: 'public' }, { KYBERION_SCOPE_ENV_PATH: '../../outside-scope.env' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('memoizes and resets the process scope', () => {
    resetCurrentScope();
    const original = {
      tenant: process.env.KYBERION_TENANT,
      organization: process.env.KYBERION_ORGANIZATION_ID,
      project: process.env.KYBERION_PROJECT_ID,
      tier: process.env.KYBERION_TIER,
    };
    try {
      process.env.KYBERION_TENANT = 'acme-corp';
      process.env.KYBERION_ORGANIZATION_ID = 'org-a';
      process.env.KYBERION_PROJECT_ID = 'project-a';
      process.env.KYBERION_TIER = 'confidential';
      const first = currentScope();
      process.env.KYBERION_PROJECT_ID = 'project-b';
      expect(currentScope()).toEqual(first);
      resetCurrentScope();
      expect(currentScope().project_id).toBe('project-b');
    } finally {
      resetCurrentScope();
      for (const [key, value] of [
        ['KYBERION_TENANT', original.tenant],
        ['KYBERION_ORGANIZATION_ID', original.organization],
        ['KYBERION_PROJECT_ID', original.project],
        ['KYBERION_TIER', original.tier],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
