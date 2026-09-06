import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeUnlinkSync, safeWriteFile } from '@agent/core/secure-io';
import {
  discoverGovernanceRuleChecks,
  findDeterministicCatalogViolations,
} from './check_governance_rules.js';

const GOVERNANCE_DIR = pathResolver.rootResolve('knowledge/product/governance');
const TEST_FILE = path.join(GOVERNANCE_DIR, 'test-governance-deterministic.json');

function runGovernanceCheck(): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-loader.mjs', 'scripts/check_governance_rules.ts'],
    { cwd: pathResolver.rootDir(), encoding: 'utf8' }
  );
  return { status: result.status, stderr: result.stderr || '' };
}

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

    expect(violations).toContain('knowledge/product/governance/test-governance-deterministic.json');
  });

  it('discovers schema-backed governance catalogs without a hand-authored entry', () => {
    const checks = discoverGovernanceRuleChecks();
    expect(checks.map((check) => check.dataPath)).toContain(
      'knowledge/product/governance/governance-catalog-contracts.json'
    );
  });

  it('reports violations through the shared script failure boundary', () => {
    safeWriteFile(TEST_FILE, JSON.stringify({ version: '1.0.0' }));

    const result = runGovernanceCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[check:governance-rules] violations detected:');
    expect(result.stderr).toContain('test-governance-deterministic.json');
  });
});
