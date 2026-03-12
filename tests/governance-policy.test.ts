import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateWritePermission, safeWriteFile, safeUnlinkSync, safeExistsSync, pathResolver } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

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
});
