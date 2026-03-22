import { afterEach, describe, expect, it } from 'vitest';
import { buildExecutionEnv, inferPersonaFromRole, resolveIdentityContext, withExecutionContext } from './authority.js';

describe('resolveIdentityContext', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;
  const originalMissionId = process.env.MISSION_ID;

  afterEach(() => {
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
    if (originalMissionId === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = originalMissionId;
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
});
