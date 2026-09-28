import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from '@agent/core/secure-io';
import { matchHighRiskPaths } from '@agent/core/governance/autonomous-ops-gate';

const rootDir = process.cwd();
const policy = JSON.parse(
  safeReadFile(path.join(rootDir, 'knowledge/product/governance/autonomous-ops-policy.json'), {
    encoding: 'utf8',
  }) as string
) as { high_risk_paths?: string[]; never_auto?: string[] };
const highRiskPaths = policy.high_risk_paths ?? [];

// Deny-by-default: a new libs/core module in one of these security domains must be
// listed in high_risk_paths before an agent could merge a change to it unattended.
const SECURITY_MODULE_NAME =
  /(approval|auth|permission|tenant|secret|trust|vault|guard|sandbox|sensitive|viewer|tier-guard|path-resolver|secure-io)/i;
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);

function listModules(relativeDir: string): string[] {
  return safeReaddir(path.join(rootDir, relativeDir)).flatMap((entry) => {
    const relative = `${relativeDir}/${entry}`;
    if (safeStat(path.join(rootDir, relative)).isDirectory()) {
      return SKIPPED_DIRS.has(entry) ? [] : listModules(relative);
    }
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [relative] : [];
  });
}

describe('Autonomous ops high-risk path coverage contract', () => {
  it('covers every security-domain libs/core module with a high-risk path glob', () => {
    const modules = listModules('libs/core')
      .filter((module) => SECURITY_MODULE_NAME.test(path.basename(module)))
      .sort((a, b) => a.localeCompare(b));

    expect(modules.length).toBeGreaterThan(0);
    const covered = new Set(matchHighRiskPaths(modules, highRiskPaths));
    expect(modules.filter((module) => !covered.has(module))).toEqual([]);
  });

  it('guards the policy, the gate and this contract', () => {
    const guarded = [
      'knowledge/product/governance/autonomous-ops-policy.json',
      'knowledge/product/schemas/autonomous-ops-policy.schema.json',
      'libs/core/governance/autonomous-ops-gate.ts',
      'libs/core/governance/autonomous-ops-gate.test.ts',
      'libs/core/foundation/governed-catalog.ts',
      'libs/core/package.json',
      'tests/autonomous-ops-high-risk-coverage-contract.test.ts',
    ];
    expect(matchHighRiskPaths(guarded, highRiskPaths)).toEqual(guarded);
  });

  it('keeps the approved never-auto classes spelled exactly', () => {
    expect([...(policy.never_auto ?? [])].sort()).toEqual([
      'cross_tenant',
      'dependency_major',
      'external_publish',
      'lower_tier_write',
      'policy_change',
      'secret_mutation',
    ]);
  });

  it('keeps literal high-risk paths pointing at files that exist', () => {
    // Created only once a plugin is installed, but must stay guarded before that.
    const createdOnDemand = new Set(['.kyberion-plugins.json']);
    const literals = highRiskPaths.filter(
      (entry) => !/[*?]/.test(entry) && !createdOnDemand.has(entry)
    );
    expect(literals.filter((entry) => !safeExistsSync(path.join(rootDir, entry)))).toEqual([]);
  });
});
