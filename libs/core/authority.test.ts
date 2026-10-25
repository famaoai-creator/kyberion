import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectScope } from './foundation/project-scope-env.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  buildExecutionEnv,
  inferPersonaFromRole,
  resolveIdentityContext,
  resolveRole,
  withExecutionContext,
  withExecutionContextAsync,
} from './authority.js';

describe('resolveIdentityContext', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;
  const originalMissionId = process.env.MISSION_ID;
  const originalSudo = process.env.KYBERION_SUDO;
  const originalSudoScope = process.env.KYBERION_SUDO_SCOPE;

  afterEach(() => {
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
    if (originalMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = originalMissionId;
    if (originalSudo === undefined) delete process.env.KYBERION_SUDO;
    else process.env.KYBERION_SUDO = originalSudo;
    if (originalSudoScope === undefined) delete process.env.KYBERION_SUDO_SCOPE;
    else process.env.KYBERION_SUDO_SCOPE = originalSudoScope;
  });

  it('routes mission identity reads through the governed environment accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/authority.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
    expect(source).not.toContain('process.env.TASK_ID');
    expect(source).toContain("getRegisteredEnvText('TASK_ID')");
    expect(source).not.toContain('process.env.MISSION_ROLE');
    expect(source).toContain("getRegisteredEnvText('MISSION_ROLE')");
    expect(source).toContain("setRegisteredEnv('MISSION_ROLE'");
  });

  it('keeps persona and authority role separate', () => {
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'mission_controller';
    delete process.env.MISSION_ID;

    const result = resolveIdentityContext();
    expect(result.persona).toBe('worker');
    expect(result.role).toBe('mission_controller');
  });

  it('normalizes known personas and leaves unknown roles untouched', () => {
    process.env.KYBERION_PERSONA = 'Ecosystem Architect';
    process.env.MISSION_ROLE = 'chronos_gateway';

    const result = resolveIdentityContext();
    expect(result.persona).toBe('ecosystem_architect');
    expect(result.role).toBe('chronos_gateway');
  });

  it('infers default persona from authority role when persona is absent', () => {
    delete process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'mission_controller';

    const result = resolveIdentityContext();
    expect(result.persona).toBe('worker');
    expect(result.role).toBe('mission_controller');
  });

  it('builds execution env with inferred persona', () => {
    const env = buildExecutionEnv({}, 'sovereign_concierge');
    expect(env.MISSION_ROLE).toBe('sovereign_concierge');
    expect(env.KYBERION_PERSONA).toBe('sovereign');
    expect(inferPersonaFromRole('ruthless_auditor')).toBe('analyst');
  });

  it('isolates explicit mission/project/task boundaries across concurrent role scopes', async () => {
    vi.stubEnv('MISSION_ID', 'MSN-PARENT');
    vi.stubEnv('KYBERION_PROJECT_ID', 'PRJ-PARENT');
    vi.stubEnv('KYBERION_TASK_ID', 'task-parent');
    try {
      const [dot, child] = await Promise.all([
        withExecutionContextAsync(
          'mission_controller',
          async () => {
            await Promise.resolve();
            return withExecutionContextAsync('mission_controller', () => ({
              mission: resolveIdentityContext().missionId,
              scope: resolveProjectScope(),
              env: buildExecutionEnv(process.env, 'mission_controller'),
            }));
          },
          undefined,
          undefined,
          undefined,
          { missionId: null, projectId: 'PRJ-DOT', taskId: null }
        ),
        withExecutionContextAsync(
          'mission_controller',
          async () => {
            await Promise.resolve();
            return { mission: resolveIdentityContext().missionId, scope: resolveProjectScope() };
          },
          undefined,
          undefined,
          undefined,
          { missionId: 'MSN-CHILD', projectId: null, taskId: 'task-child' }
        ),
      ]);
      expect(dot.mission).toBeUndefined();
      expect(dot.scope).toMatchObject({ projectId: 'PRJ-DOT' });
      expect(dot.scope.missionId).toBeUndefined();
      expect(dot.scope.taskId).toBeUndefined();
      expect(dot.env).toMatchObject({
        MISSION_ID: '',
        KYBERION_PROJECT_ID: 'PRJ-DOT',
        KYBERION_TASK_ID: '',
        TASK_ID: '',
      });
      expect(child.mission).toBe('MSN-CHILD');
      expect(child.scope).toMatchObject({ missionId: 'MSN-CHILD', taskId: 'task-child' });
      expect(child.scope.projectId).toBeUndefined();
      expect(process.env.MISSION_ID).toBe('MSN-PARENT');
      expect(process.env.KYBERION_PROJECT_ID).toBe('PRJ-PARENT');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects invalid explicit identity before entering the role scope', () => {
    expect(() =>
      withExecutionContext('mission_controller', () => true, undefined, undefined, undefined, {
        missionId: '../other',
      })
    ).toThrow('invalid execution identity');
  });

  it('does not grant SUDO intrinsically to ecosystem_architect', () => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    delete process.env.KYBERION_SUDO;

    const result = resolveIdentityContext();
    expect(result.authorities).not.toContain('SUDO');
    expect(result.authorities).toContain('SYSTEM_EXEC');
  });

  it('grants SUDO only when explicitly requested', () => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.KYBERION_SUDO = 'true';

    const result = resolveIdentityContext();
    expect(result.authorities).toContain('SUDO');
  });

  it('records sudo scope when explicitly provided', () => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.KYBERION_SUDO = 'true';
    process.env.KYBERION_SUDO_SCOPE = 'active/shared/tmp/,knowledge/public/';

    const result = resolveIdentityContext();
    expect(result.sudoScope).toEqual(['active/shared/tmp/', 'knowledge/public/']);
  });

  it('applies execution context and restores previous env', () => {
    process.env.MISSION_ROLE = 'software_developer';
    process.env.KYBERION_PERSONA = 'worker';

    const inside = withExecutionContext('mission_controller', () => ({
      role: process.env.MISSION_ROLE,
      persona: process.env.KYBERION_PERSONA,
    }));

    expect(inside).toEqual({ role: 'mission_controller', persona: 'worker' });
    expect(process.env.MISSION_ROLE).toBe('software_developer');
    expect(process.env.KYBERION_PERSONA).toBe('worker');
  });

  it('keeps execution context through async governed work', async () => {
    delete process.env.MISSION_ROLE;
    delete process.env.KYBERION_PERSONA;

    const inside = await withExecutionContextAsync('mission_controller', async () => {
      await Promise.resolve();
      const identity = resolveIdentityContext();
      return {
        role: identity.role,
        persona: identity.persona,
        // B1: the async helper keeps the assumption in scope only.
        envRole: process.env.MISSION_ROLE,
      };
    });

    expect(inside).toEqual({ role: 'mission_controller', persona: 'worker', envRole: undefined });
    expect(process.env.MISSION_ROLE).toBeUndefined();
    expect(process.env.KYBERION_PERSONA).toBeUndefined();
  });
});
