import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listIdentityDirectory, showIdentity } from './identity-directory.js';

describe('identity-directory', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });
  afterEach(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });
  it('lists humans without throwing', () => {
    const entries = listIdentityDirectory({ kind: 'human' });
    expect(Array.isArray(entries)).toBe(true);
  });
  it('returns null for unknown actors', () => {
    expect(showIdentity('user:no-such-member-zzz')).toBeNull();
    expect(showIdentity('kyberion://agent/no-org/no-such-zzz')).toBeNull();
    expect(showIdentity('not-an-actor')).toBeNull();
  });
});
