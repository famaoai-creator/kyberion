import { describe, it, expect, afterAll } from 'vitest';
import { validateWritePermission, validateReadPermission, safeWriteFile, safeUnlinkSync, safeExistsSync, pathResolver } from '@agent/core';
import * as path from 'node:path';

describe('Governance Policy-as-Code Enforcement', () => {
  const TEST_FILE = pathResolver.knowledge('public/test-policy-effect.md');

  afterAll(() => {
    process.env.MISSION_ROLE = 'ecosystem_architect'; 
    if (safeExistsSync(TEST_FILE)) safeUnlinkSync(TEST_FILE);
  });

  it('Scenario: ecosystem_architect can write to knowledge (Allowed by Policy)', async () => {
    // Simulate role
    process.env.MISSION_ROLE = 'ecosystem_architect';
    const check = validateWritePermission(TEST_FILE);
    expect(check.allowed).toBe(true);
    
    // Physical write test
    safeWriteFile(TEST_FILE, '# Policy Test');
    expect(safeExistsSync(TEST_FILE)).toBe(true);
  });

  it('Scenario: unknown role cannot write to knowledge/confidential (Blocked by Tier Policy)', async () => {
    const CONFIDENTIAL_FILE = pathResolver.knowledge('confidential/test-block.md');
    
    // Explicitly set restricted environment
    process.env.MISSION_ROLE = 'unknown_intruder';
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

  it('Scenario: Default allow paths (Scratch) work for everyone', async () => {
    const SCRATCH_FILE = pathResolver.rootResolve('scratch/test-default-allow.txt');
    process.env.MISSION_ROLE = 'any_role';
    const check = validateWritePermission(SCRATCH_FILE);
    expect(check.allowed).toBe(true);

    safeWriteFile(SCRATCH_FILE, 'test');
    expect(safeExistsSync(SCRATCH_FILE)).toBe(true);
    safeUnlinkSync(SCRATCH_FILE);
  });

  it('Scenario: mission_controller can write distilled wisdom output', async () => {
    const WISDOM_FILE = pathResolver.rootResolve('knowledge/evolution/test-mission-controller-distill.md');
    process.env.MISSION_ROLE = 'mission_controller';

    const check = validateWritePermission(WISDOM_FILE);
    expect(check.allowed).toBe(true);

    safeWriteFile(WISDOM_FILE, '# Distilled Wisdom');
    expect(safeExistsSync(WISDOM_FILE)).toBe(true);
    safeUnlinkSync(WISDOM_FILE);
  });
});

describe('Read Permission Control (validateReadPermission)', () => {
  afterAll(() => {
    process.env.MISSION_ROLE = 'ecosystem_architect';
  });

  it('public knowledge is always readable', () => {
    const file = pathResolver.knowledge('public/governance/security-policy.json');
    process.env.MISSION_ROLE = 'any_role';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });

  it('non-knowledge paths are always readable', () => {
    const file = pathResolver.rootResolve('scripts/mission_controller.ts');
    process.env.MISSION_ROLE = 'any_role';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });

  it('personal knowledge is blocked for unknown roles', () => {
    const file = pathResolver.knowledge('personal/my-identity.json');
    process.env.MISSION_ROLE = 'unknown_intruder';
    process.env.MISSION_ID = '';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(false);
  });

  it('confidential knowledge is blocked for unknown roles', () => {
    const file = pathResolver.knowledge('confidential/secret-doc.md');
    process.env.MISSION_ROLE = 'unknown_intruder';
    process.env.MISSION_ID = '';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(false);
  });

  it('mission_controller can read personal knowledge (privileged)', () => {
    const file = pathResolver.knowledge('personal/my-identity.json');
    process.env.MISSION_ROLE = 'mission_controller';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });

  it('ecosystem_architect can read confidential knowledge (privileged)', () => {
    const file = pathResolver.knowledge('confidential/secret-doc.md');
    process.env.MISSION_ROLE = 'ecosystem_architect';
    const result = validateReadPermission(file);
    expect(result.allowed).toBe(true);
  });
});
