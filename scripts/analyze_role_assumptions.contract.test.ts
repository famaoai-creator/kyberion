import { describe, expect, it } from 'vitest';
import { readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  NARROWED_SYSTEM_ROLES,
  checkReachabilityInvariants,
  formatViolations,
  type RoleAssumptionPolicyFile,
  type RoleAssumptionReachabilityReport,
  type SystemRoleReachability,
} from './analyze_role_assumptions.js';

/**
 * RN-03: role-assumption-policy.json must grant every role the call-level
 * analysis reaches, so code that adds an assumption breaks CI instead of
 * failing in production with [ROLE_ASSUMPTION_DENIED]. The
 * `role-assumption-reachability` gate computes the report in memory (it is
 * not committed) and runs checkReachabilityInvariants on it; these tests pin
 * each invariant on synthetic reports, so the gate's failure modes are proven
 * without the ~100s whole-repo analysis.
 */
const policy = readJson<RoleAssumptionPolicyFile>(
  pathResolver.rootResolve('knowledge/product/governance/role-assumption-policy.json')
);

function entry(overrides: Partial<SystemRoleReachability> = {}): SystemRoleReachability {
  return {
    entries: ['apps/surface.ts'],
    reviewed_infeasible: [],
    child_process_entries: [],
    reachable_roles: {},
    unresolved_sites: [],
    policy_roles_not_reachable: [],
    ...overrides,
  };
}

function reportOf(systemRoles: Record<string, SystemRoleReachability>) {
  return {
    version: 1,
    generated_by: 'test',
    description: 'test',
    assumption_sites: [],
    unresolved_sites: {},
    system_roles: systemRoles,
  } satisfies RoleAssumptionReachabilityReport;
}

const fixturePolicy: RoleAssumptionPolicyFile = {
  shared_core_roles: { roles: ['shared_writer'] },
  system_roles: { surface_a: { may_assume: ['granted_role'] } },
};

describe('RN-03 role assumption invariants (role-assumption-reachability gate)', () => {
  it('passes when every reachable role is granted (own, shared or may_assume)', () => {
    const report = reportOf({
      surface_a: entry({
        reachable_roles: {
          surface_a: { example_path: ['a#self'] },
          shared_writer: { example_path: ['a#shared'] },
          granted_role: { example_path: ['a#granted'] },
        },
      }),
    });
    expect(checkReachabilityInvariants(report, fixturePolicy)).toEqual([]);
  });

  it('fails when a reachable role is not granted, naming the role and its path', () => {
    const report = reportOf({
      surface_a: entry({
        reachable_roles: {
          granted_role: { example_path: ['a#granted'] },
          ungranted_role: { example_path: ['apps/surface.ts#main', 'libs/core/x.ts#write'] },
        },
      }),
    });
    const violations = checkReachabilityInvariants(report, fixturePolicy);
    expect(violations).toEqual([
      expect.objectContaining({ rule: 'reachable-role-not-granted', system_role: 'surface_a' }),
    ]);
    expect(violations[0]!.message).toContain('surface_a can assume ungranted_role');
    expect(violations[0]!.message).toContain('apps/surface.ts#main -> libs/core/x.ts#write');
    expect(violations[0]!.message).toContain('| next:');
    expect(formatViolations(violations)).toMatch(/1 RN-03 invariant violation/);
  });

  it('does not let one system role borrow another role’s grants', () => {
    const report = reportOf({
      surface_a: entry(),
      surface_b: entry({ reachable_roles: { granted_role: { example_path: ['b#x'] } } }),
    });
    const policyWithB = {
      ...fixturePolicy,
      system_roles: { ...fixturePolicy.system_roles, surface_b: { may_assume: [] } },
    };
    expect(checkReachabilityInvariants(report, policyWithB).map((v) => v.rule)).toEqual([
      'reachable-role-not-granted',
    ]);
  });

  it('requires the analysis and the policy to cover the same system roles', () => {
    const report = reportOf({ surface_new: entry() });
    expect(
      checkReachabilityInvariants(report, fixturePolicy).map((v) => [v.rule, v.system_role])
    ).toEqual([
      ['analysed-role-not-in-policy', 'surface_new'],
      ['policy-role-not-analysed', 'surface_a'],
    ]);
  });

  it('requires every SYSTEM_ROLE a package script launches to be analysed', () => {
    const report = reportOf({ surface_a: entry() });
    const violations = checkReachabilityInvariants(report, fixturePolicy, {
      ok: 'SYSTEM_ROLE=surface_a node a.js',
      missing: 'SYSTEM_ROLE=surface_launched node b.js',
    });
    expect(violations.map((v) => [v.rule, v.system_role])).toEqual([
      ['launched-role-not-analysed', 'surface_launched'],
    ]);
  });

  it('keeps every narrowed system role fully resolved (S2)', () => {
    const narrowed = NARROWED_SYSTEM_ROLES[0]!;
    const narrowedPolicy = { ...fixturePolicy, system_roles: { [narrowed]: { may_assume: [] } } };
    const resolved = reportOf({ [narrowed]: entry() });
    expect(checkReachabilityInvariants(resolved, narrowedPolicy)).toEqual([]);
    const unresolved = reportOf({
      [narrowed]: entry({
        unresolved_sites: ['libs/core/dyn.ts#load'],
        child_process_entries: [{ site: 'scripts/x.ts#spawn', targets: ['scripts/y.ts'] }],
      }),
    });
    const violations = checkReachabilityInvariants(unresolved, narrowedPolicy);
    expect(violations.map((v) => v.rule)).toEqual(['narrowed-role-unresolved']);
    expect(violations[0]!.message).toContain('any-role site libs/core/dyn.ts#load');
    expect(violations[0]!.message).toContain('child process scripts/x.ts#spawn');
  });

  it('governs every narrowed system role and every launched SYSTEM_ROLE in the real policy', () => {
    for (const systemRole of NARROWED_SYSTEM_ROLES) {
      expect(Object.keys(policy.system_roles), systemRole).toContain(systemRole);
    }
    const scripts = readJson<{ scripts: Record<string, string> }>(
      pathResolver.rootResolve('package.json')
    ).scripts;
    const launched = Object.values(scripts).flatMap((command) =>
      [...command.matchAll(/\bSYSTEM_ROLE=([a-z0-9_]+)/g)].map((match) => match[1])
    );
    expect(launched.length).toBeGreaterThan(0);
    for (const systemRole of launched) {
      expect(Object.keys(policy.system_roles)).toContain(systemRole);
    }
  });
});
