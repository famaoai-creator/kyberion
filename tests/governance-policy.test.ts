import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { safeWriteFile, safeUnlinkSync, safeExistsSync, pathResolver } from '@agent/core';
import { validateWritePermission, validateReadPermission } from '@agent/core/governance';
import * as path from 'node:path';

describe('Governance Policy-as-Code Enforcement', () => {
  const TEST_FILE = pathResolver.knowledge('public/test-policy-effect.md');

  afterAll(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'ecosystem_architect'; 
    if (safeExistsSync(TEST_FILE)) safeUnlinkSync(TEST_FILE);
  });

  it('Scenario: ecosystem_architect persona can write to knowledge (Allowed by Policy)', async () => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'software_developer';
    const check = validateWritePermission(TEST_FILE);
    expect(check.allowed).toBe(true);
    
    // Physical write test
    safeWriteFile(TEST_FILE, '# Policy Test');
    expect(safeExistsSync(TEST_FILE)).toBe(true);
  });

  it('Scenario: unknown role cannot write to knowledge/confidential (Blocked by Tier Policy)', async () => {
    const CONFIDENTIAL_FILE = pathResolver.knowledge('confidential/test-block.md');
    
    process.env.MISSION_ROLE = 'unknown_intruder';
    process.env.KYBERION_PERSONA = 'unknown';
    process.env.MISSION_ID = ''; 
    
    const root = pathResolver.rootDir();
    const rel = path.relative(root, CONFIDENTIAL_FILE);
    console.log(`[TEST_DEBUG] Target: ${CONFIDENTIAL_FILE}`);
    console.log(`[TEST_DEBUG] Root: ${root}`);
    console.log(`[TEST_DEBUG] Relative: ${rel}`);
    
    const check = validateWritePermission(CONFIDENTIAL_FILE);
    console.log(`[TEST_DEBUG] Result: allowed=${check.allowed}, reason=${check.reason}`);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Organization Confidential');
    
    try {
      safeWriteFile(CONFIDENTIAL_FILE, 'Illegal content');
      throw new Error('Should have been blocked');
    } catch (err: any) {
      expect(err.message).toContain('Organization Confidential'); 
    }
  });

  it('Scenario: Default allow runtime temp paths work for everyone', async () => {
    const SCRATCH_FILE = pathResolver.sharedTmp('tests/test-default-allow.txt');
    process.env.MISSION_ROLE = 'any_role';
    process.env.KYBERION_PERSONA = 'unknown';
    const check = validateWritePermission(SCRATCH_FILE);
    expect(check.allowed).toBe(true);

    safeWriteFile(SCRATCH_FILE, 'test');
    expect(safeExistsSync(SCRATCH_FILE)).toBe(true);
    safeUnlinkSync(SCRATCH_FILE);
  });

  it('Scenario: mission_controller can write distilled wisdom output', async () => {
    const WISDOM_FILE = pathResolver.rootResolve('knowledge/evolution/test-mission-controller-distill.md');
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';

    const check = validateWritePermission(WISDOM_FILE);
    expect(check.allowed).toBe(true);

    safeWriteFile(WISDOM_FILE, '# Distilled Wisdom');
    expect(safeExistsSync(WISDOM_FILE)).toBe(true);
    safeUnlinkSync(WISDOM_FILE);
  });
});

describe('Read Permission Control (validateReadPermission)', () => {
  afterAll(() => {
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'ecosystem_architect';
  });

  it('public knowledge is always readable', () => {
    const file = pathResolver.knowledge('public/governance/security-policy.json');
    process.env.MISSION_ROLE = 'any_role';
    process.env.KYBERION_PERSONA = 'unknown';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });

  it('non-knowledge paths are always readable', () => {
    const file = pathResolver.rootResolve('scripts/mission_controller.ts');
    process.env.MISSION_ROLE = 'any_role';
    process.env.KYBERION_PERSONA = 'unknown';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });

  it('personal knowledge is blocked for unknown persona and authority role', () => {
    const file = pathResolver.knowledge('personal/my-identity.json');
    process.env.MISSION_ROLE = 'unknown_intruder';
    process.env.KYBERION_PERSONA = 'unknown';
    process.env.MISSION_ID = '';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(false);
  });

  it('confidential knowledge is blocked for unknown roles', () => {
    const file = pathResolver.knowledge('confidential/secret-doc.md');
    process.env.MISSION_ROLE = 'unknown_intruder';
    process.env.KYBERION_PERSONA = 'unknown';
    process.env.MISSION_ID = '';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(false);
  });

  it('mission_controller authority role can read personal knowledge', () => {
    const file = pathResolver.knowledge('personal/my-identity.json');
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });

  it('chronos_operator cannot read personal mission knowledge', () => {
    const file = pathResolver.knowledge('personal/missions');
    process.env.MISSION_ROLE = 'chronos_operator';
    process.env.KYBERION_PERSONA = 'worker';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(false);
  });

  it('chronos_localadmin remains blocked from personal mission knowledge', () => {
    const file = pathResolver.knowledge('personal/missions');
    process.env.MISSION_ROLE = 'chronos_localadmin';
    process.env.KYBERION_PERSONA = 'worker';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(false);
  });

  it('ecosystem_architect persona can read confidential knowledge', () => {
    const file = pathResolver.knowledge('confidential/secret-doc.md');
    process.env.MISSION_ROLE = 'software_developer';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });
});

describe('Scoped SUDO enforcement', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;
  const originalSudo = process.env.KYBERION_SUDO;
  const originalSudoScope = process.env.KYBERION_SUDO_SCOPE;

  afterEach(() => {
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
    if (originalSudo === undefined) delete process.env.KYBERION_SUDO;
    else process.env.KYBERION_SUDO = originalSudo;
    if (originalSudoScope === undefined) delete process.env.KYBERION_SUDO_SCOPE;
    else process.env.KYBERION_SUDO_SCOPE = originalSudoScope;
  });

  it('limits SUDO writes to configured scope when scope is present', () => {
    process.env.KYBERION_PERSONA = 'unknown';
    process.env.MISSION_ROLE = 'unknown_intruder';
    process.env.KYBERION_SUDO = 'true';
    process.env.KYBERION_SUDO_SCOPE = 'active/shared/tmp/';

    const allowed = validateWritePermission(pathResolver.sharedTmp('scoped-sudo.txt'));
    const blocked = validateWritePermission(pathResolver.knowledge('public/scoped-sudo-blocked.md'));

    expect(allowed.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
  });
});
