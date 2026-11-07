import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeUnlinkSync, safeWriteFile } from '@agent/core/secure-io';
import {
  discoverGovernanceRuleChecks,
  findDeterministicCatalogViolations,
  runCheckGovernanceRules,
} from './check_governance_rules.js';

const GOVERNANCE_DIR = pathResolver.rootResolve('knowledge/product/governance');
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

    expect(violations).toContain('knowledge/product/governance/test-governance-deterministic.json');
  });

  it('discovers schema-backed governance catalogs without a hand-authored entry', () => {
    const checks = discoverGovernanceRuleChecks();
    expect(checks.map((check) => check.dataPath)).toContain(
      'knowledge/product/governance/governance-catalog-contracts.json'
    );
  });

  it('reports violations through the shared script failure boundary', async () => {
    safeWriteFile(TEST_FILE, JSON.stringify({ version: '1.0.0' }));

    const previousExitCode = process.exitCode;
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.exitCode = undefined;
      await runCheckGovernanceRules([]);
      expect(process.exitCode).toBe(1);
      const output = stderr.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(output).toContain('[check:governance-rules] violations detected:');
      expect(output).toContain('test-governance-deterministic.json');
    } finally {
      stderr.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});
