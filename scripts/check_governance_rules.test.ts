import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeUnlinkSync, safeWriteFile } from '@agent/core';
import { findDeterministicCatalogViolations } from './check_governance_rules.js';

const GOVERNANCE_DIR = pathResolver.rootResolve('knowledge/public/governance');
const TEST_FILE = path.join(GOVERNANCE_DIR, 'test-governance-deterministic.json');

describe('check_governance_rules', () => {
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });

  afterEach(() => {
    if (safeExistsSync(TEST_FILE)) {
      safeUnlinkSync(TEST_FILE);
    }
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('flags deterministic catalog leftovers', () => {
    safeWriteFile(TEST_FILE, JSON.stringify({ version: '1.0.0' }));

    const violations = findDeterministicCatalogViolations();

    expect(violations).toContain('knowledge/public/governance/test-governance-deterministic.json');
  });
});
