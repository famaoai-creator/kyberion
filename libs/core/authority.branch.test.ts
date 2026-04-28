import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExistsSync: vi.fn(),
  safeReadFile: vi.fn(),
  active: vi.fn((p: string) => `/repo/active/${p}`),
  findMissionPath: vi.fn((_id: string) => null as string | null),
}));

vi.mock('./secure-io.js', () => ({
  safeExistsSync: mocks.safeExistsSync,
  safeReadFile: mocks.safeReadFile,
}));

vi.mock('./path-resolver.js', () => ({
  active: mocks.active,
  findMissionPath: mocks.findMissionPath,
}));

describe('authority branch coverage', () => {
  const originalArgv = [...process.argv];
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mocks.safeExistsSync.mockReset();
    mocks.safeReadFile.mockReset();
    mocks.active.mockReset();
    mocks.active.mockImplementation((p: string) => `/repo/active/${p}`);
    mocks.findMissionPath.mockReset();
    mocks.findMissionPath.mockReturnValue(null);
    mocks.safeExistsSync.mockReturnValue(false);
    mocks.safeReadFile.mockReturnValue('{}');

    delete process.env.KYBERION_PERSONA;
    delete process.env.MISSION_ROLE;
    delete process.env.SYSTEM_ROLE;
    delete process.env.MISSION_ID;
    delete process.env.KYBERION_SUDO;
    delete process.env.KYBERION_SUDO_SCOPE;
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves persona from mission-state when env persona is unknown', async () => {
    process.env.MISSION_ID = 'MSN-1';
    process.env.MISSION_ROLE = 'chronos_gateway';
    process.env.KYBERION_PERSONA = 'mystery';
    mocks.safeExistsSync.mockImplementation((p: string) => p.endsWith('/missions/MSN-1/mission-state.json'));
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/missions/MSN-1/mission-state.json')) {
        return JSON.stringify({ assigned_persona: 'Ecosystem Architect' });
      }
      return '[]';
    });

    const { resolveIdentityContext } = await import('./authority.js');
    const ctx = resolveIdentityContext();
    expect(ctx.persona).toBe('ecosystem_architect');
    expect(ctx.role).toBe('chronos_gateway');
  });

  it('falls back to process name heuristic when role/persona are unknown', async () => {
    process.argv[1] = '/tmp/my-controller.ts';
    const { resolveIdentityContext } = await import('./authority.js');
    const ctx = resolveIdentityContext();
    expect(ctx.persona).toBe('ecosystem_architect');
    expect(ctx.role).toBe('my_controller');
  });

  it('adds persona intrinsic authorities and mission temporal grants', async () => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ID = 'MSN-42';
    mocks.safeExistsSync.mockImplementation((p: string) => p.endsWith('/active/shared/auth-grants.json'));
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/active/shared/auth-grants.json')) {
        return JSON.stringify([
          { missionId: 'MSN-42', serviceId: 'github', expiresAt: Date.now() + 60_000 },
          { missionId: 'MSN-42', authority: 'KNOWLEDGE_WRITE', expiresAt: Date.now() + 60_000 },
          { missionId: 'MSN-OTHER', authority: 'SECRET_READ', expiresAt: Date.now() + 60_000 },
          { missionId: 'MSN-42', authority: 'SYSTEM_EXEC', expiresAt: Date.now() - 1 },
        ]);
      }
      return '{}';
    });

    const { resolveIdentityContext } = await import('./authority.js');
    const ctx = resolveIdentityContext();
    expect(ctx.authorities).toContain('GIT_WRITE');
    expect(ctx.authorities).toContain('NETWORK_FETCH');
    expect(ctx.authorities).toContain('KNOWLEDGE_WRITE');
    expect(ctx.authorities).toContain('SYSTEM_EXEC');
  });

  it('handles malformed grants file without throwing', async () => {
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ID = 'MSN-9';
    mocks.safeExistsSync.mockImplementation((p: string) => p.endsWith('/active/shared/auth-grants.json'));
    mocks.safeReadFile.mockReturnValue('{bad json');

    const { resolveIdentityContext } = await import('./authority.js');
    const ctx = resolveIdentityContext();
    expect(ctx.authorities).toEqual([]);
  });

  it('buildExecutionEnv keeps existing persona when explicit persona is unknown', async () => {
    const { buildExecutionEnv } = await import('./authority.js');
    const env = buildExecutionEnv({ KYBERION_PERSONA: 'worker' }, 'unmapped_role');
    expect(env.MISSION_ROLE).toBe('unmapped_role');
    expect(env.KYBERION_PERSONA).toBe('worker');
  });

  it('withExecutionContext deletes temporary persona when role has no inferred persona', async () => {
    process.env.MISSION_ROLE = 'software_developer';
    process.env.KYBERION_PERSONA = 'analyst';
    const { withExecutionContext } = await import('./authority.js');
    const inside = withExecutionContext('unmapped_role', () => ({
      role: process.env.MISSION_ROLE,
      persona: process.env.KYBERION_PERSONA,
    }));
    expect(inside.role).toBe('unmapped_role');
    expect(inside.persona).toBeUndefined();
    expect(process.env.MISSION_ROLE).toBe('software_developer');
    expect(process.env.KYBERION_PERSONA).toBe('analyst');
  });

  it('hasAuthority respects SUDO override and direct authority match', async () => {
    const mod = await import('./authority.js');

    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ID = 'MSN-SUDO';
    process.env.KYBERION_SUDO = 'true';
    expect(mod.hasAuthority('SECRET_READ')).toBe(true);

    delete process.env.KYBERION_SUDO;
    mocks.safeExistsSync.mockImplementation((p: string) => p.endsWith('/active/shared/auth-grants.json'));
    mocks.safeReadFile.mockImplementation((p: string) => {
      if (p.endsWith('/active/shared/auth-grants.json')) {
        return JSON.stringify([{ missionId: 'MSN-SUDO', authority: 'SECRET_READ', expiresAt: Date.now() + 10_000 }]);
      }
      return '{}';
    });
    expect(mod.hasAuthority('SECRET_READ')).toBe(true);
    expect(mod.hasAuthority('SYSTEM_EXEC')).toBe(false);
  });
});
