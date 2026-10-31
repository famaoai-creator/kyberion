/**
 * RN-02: call-level static analysis of in-process role assumption.
 *
 * role-assumption-policy.json bounds which roles a SYSTEM_ROLE process may
 * assume with withExecutionContext / withExecutionContextAsync. Its first
 * lists came from module-level reachability, so every surface was granted the
 * broad roles any libs/core module assumes. This script narrows the evidence
 * to top-level declarations:
 *
 *  1. It collects every withExecutionContext* call and resolves the role
 *     argument (a literal, a union of literals via the type checker, or a role
 *     forwarded through wrapper parameters such as the governed-artifact
 *     writers). Anything it cannot resolve is an "any role" site.
 *  2. It builds a reference graph between top-level declarations (functions,
 *     classes, function-valued consts) and module initialisation code,
 *     following imports, re-exports, function references and class members.
 *  3. From each surface entry point (surface manifests, surface_runtime,
 *     config_mission / run_pipeline) it walks the graph, plus the child
 *     processes those entry points spawn with an inherited SYSTEM_ROLE, and
 *     reports per system role the reachable roles (with one example path) and
 *     the policy roles that are not reachable.
 *
 * It errs towards reachability: a referenced declaration is reachable whether
 * it is called or passed around, a referenced class brings all its members,
 * nested functions follow their container, module initialisation code runs
 * whenever the module is imported, all exports of an entry file and of a
 * dynamically imported or namespace-used module are reachable, and an
 * unresolved dynamic import or an unresolved child process that inherits
 * SYSTEM_ROLE is reported as an "any role" site.
 *
 * The report is computed in memory and is not committed (it changed in about
 * a fifth of all commits and was a constant merge-conflict source). Running
 * the script (the `role-assumption-reachability` CI gate) checks the RN-03
 * invariants against role-assumption-policy.json and package.json
 * (checkReachabilityInvariants) and exits 1 with one diagnostic per
 * violation. `--write-report` also writes the full report for a human to
 * read to active/shared/cache/system/role-assumption/reachability.json (the
 * re-generable system cache floor); `--check` is
 * accepted for compatibility and changes nothing.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { resolveStorageFloor, SYSTEM_PARTITION } from '@agent/core/storage-layout';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { guardCliArgs, hasCliFlag, type CliGuardSpec } from './lib/cli-guard.js';
import { readSafeJsonFile } from './lib/json-input.js';
import {
  Analyzer,
  type RoleRecord,
  type SpawnRecord,
  type Unit,
} from './lib/role-assumption-graph.js';
import { REVIEWED_INFEASIBLE_ASSUMPTIONS } from './lib/role-assumption-reviews.js';
import {
  collectSources,
  collectSystemRoleEntries,
  compareCodeUnits,
  createProgram,
  createResolver,
  createWorkspace,
  type Workspace,
} from './lib/role-assumption-workspace.js';

/** Where `--write-report` puts the report: re-generable, so the system cache floor; never committed. */
export function reachabilityReportPath(): string {
  return resolveStorageFloor('cache', SYSTEM_PARTITION, 'role-assumption', 'reachability.json');
}
const POLICY_PATH = 'knowledge/product/governance/role-assumption-policy.json';

export interface ReachableRole {
  example_path: string[];
}

export interface ChildProcessEntry {
  site: string;
  targets: string[];
}

export interface ReviewedInfeasible {
  role: string;
  site: string;
  rationale: string;
}

export interface SystemRoleReachability {
  entries: string[];
  reviewed_infeasible: ReviewedInfeasible[];
  child_process_entries: ChildProcessEntry[];
  reachable_roles: Record<string, ReachableRole>;
  /** Reachable sites that may assume any role (keys of the report's `unresolved_sites`). */
  unresolved_sites: string[];
  policy_roles_not_reachable: string[];
}

export interface AssumptionSiteReport {
  site: string;
  roles: string[];
  unresolved: string[];
}

export interface RoleAssumptionReachabilityReport {
  version: 1;
  generated_by: string;
  description: string;
  assumption_sites: AssumptionSiteReport[];
  /** Sites treated as "may assume any role", with the reasons. */
  unresolved_sites: Record<string, string[]>;
  system_roles: Record<string, SystemRoleReachability>;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface RoleAssumptionPolicyFile {
  shared_core_roles: { roles: string[] };
  system_roles: Record<string, { may_assume: string[] }>;
}

function bfs(analyzer: Analyzer, entryUnits: Unit[]): Map<Unit, Unit | null> {
  const parents = new Map<Unit, Unit | null>();
  const queue: Unit[] = [];
  for (const unit of entryUnits) {
    if (parents.has(unit)) continue;
    parents.set(unit, null);
    queue.push(unit);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const unit = queue[index];
    for (const next of analyzer.edges.get(unit) ?? []) {
      if (parents.has(next)) continue;
      parents.set(next, unit);
      queue.push(next);
    }
  }
  return parents;
}

/**
 * The BFS path to `unit`. A child-process entry continues through the unit
 * that spawned it (`childOrigins`, keyed by the child entry file).
 */
function pathTo(
  parents: Map<Unit, Unit | null>,
  unit: Unit,
  childOrigins: Map<string, Unit> = new Map()
): string[] {
  const chain: string[] = [];
  const seen = new Set<Unit>();
  let current: Unit | null | undefined = unit;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    const origin = parent === null ? childOrigins.get(current.file) : undefined;
    chain.unshift(origin ? `${current.id} [child process]` : current.id);
    current = origin ?? parent;
  }
  return chain;
}

function entryUnitsFor(analyzer: Analyzer, ws: Workspace, files: string[]): Unit[] {
  const units: Unit[] = [];
  for (const file of files) {
    const rel = ws.rel(file);
    for (const unit of analyzer.units.unitsOfFile(rel)) {
      if (unit.exported) units.push(...analyzer.returnedCapabilityUnits(unit));
      if (!unit.lazy || unit.exported || unit.entryOnly) units.push(unit);
    }
  }
  return units;
}

export function buildReachabilityReport(
  root: string = pathResolver.rootDir()
): RoleAssumptionReachabilityReport {
  const ws = createWorkspace(root);
  const entries = collectSystemRoleEntries(ws);
  const packageJson = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    path.join(root, 'package.json'),
    'package.json'
  );
  const allRoots = new Set<string>();
  for (const files of entries.values()) for (const file of files) allRoots.add(file);
  // Child-process targets are added lazily; include every script so the program
  // already holds them (they are only walked when a spawn reaches them).
  for (const dir of ['scripts', 'libs/core', 'libs/actuators']) {
    for (const file of collectSources(ws, ws.abs(dir))) allRoots.add(file);
  }
  const resolveModule = createResolver(ws);
  const program = createProgram(ws, [...allRoots].sort(), resolveModule);
  const analyzer = new Analyzer(ws, program, packageJson.scripts ?? {}, resolveModule);
  const policy = readSafeJsonFile<RoleAssumptionPolicyFile>(
    path.join(root, POLICY_PATH),
    'role assumption policy'
  );

  const recordsByUnit = new Map<Unit, RoleRecord[]>();
  for (const record of analyzer.roleRecords) {
    const list = recordsByUnit.get(record.unit) ?? [];
    list.push(record);
    recordsByUnit.set(record.unit, list);
  }
  const spawnsByUnit = new Map<Unit, SpawnRecord[]>();
  for (const record of analyzer.spawnRecords) {
    const list = spawnsByUnit.get(record.unit) ?? [];
    list.push(record);
    spawnsByUnit.set(record.unit, list);
  }

  const systemRoles: Record<string, SystemRoleReachability> = {};
  const unresolvedSites = new Map<string, Set<string>>();
  for (const [systemRole, files] of entries) {
    const entryFiles = new Set(files.map((file) => ws.rel(file)));
    const childEntries: ChildProcessEntry[] = [];
    const childOrigins = new Map<string, Unit>();
    let parents = new Map<Unit, Unit | null>();
    // Iterate: spawned children that inherit SYSTEM_ROLE add their own entries.
    for (;;) {
      parents = bfs(
        analyzer,
        entryUnitsFor(
          analyzer,
          ws,
          [...entryFiles].map((rel) => ws.abs(rel))
        )
      );
      let added = false;
      for (const unit of parents.keys()) {
        for (const spawn of spawnsByUnit.get(unit) ?? []) {
          if (!spawn.inheritsSystemRole || spawn.targets.length === 0) continue;
          for (const target of spawn.targets) {
            if (!entryFiles.has(target)) {
              entryFiles.add(target);
              childOrigins.set(target, unit);
              added = true;
            }
          }
          const existing = childEntries.find((entry) => entry.site === spawn.site);
          if (existing) {
            existing.targets = [...new Set([...existing.targets, ...spawn.targets])].sort();
          } else {
            childEntries.push({ site: spawn.site, targets: spawn.targets });
          }
        }
      }
      if (!added) break;
    }
    const reachable: Record<string, ReachableRole> = {};
    const reviewedInfeasible: ReviewedInfeasible[] = [];
    const unresolved = new Set<string>();
    const addUnresolved = (site: string, reason: string): void => {
      unresolved.add(site);
      const reasons = unresolvedSites.get(site) ?? new Set<string>();
      reasons.add(reason);
      unresolvedSites.set(site, reasons);
    };
    for (const unit of [...parents.keys()].sort((a, b) => compareCodeUnits(a.id, b.id))) {
      for (const record of recordsByUnit.get(unit) ?? []) {
        for (const role of [...record.roles].sort()) {
          const infeasible = REVIEWED_INFEASIBLE_ASSUMPTIONS.find(
            (entry) =>
              entry.role === role &&
              entry.systemRoles.includes(systemRole) &&
              (record.site === entry.site || record.site.startsWith(`${entry.site} `))
          );
          if (infeasible) {
            if (
              !reviewedInfeasible.some(
                (item) => item.role === role && item.site === infeasible.site
              )
            ) {
              reviewedInfeasible.push({
                role,
                site: infeasible.site,
                rationale: infeasible.rationale,
              });
            }
            continue;
          }
          if (!reachable[role]) {
            reachable[role] = { example_path: pathTo(parents, unit, childOrigins) };
          }
        }
        for (const reason of record.unresolved) addUnresolved(record.site, reason);
      }
      for (const reason of analyzer.unresolvedEdges.get(unit) ?? []) {
        addUnresolved(unit.id, reason);
      }
      for (const spawn of spawnsByUnit.get(unit) ?? []) {
        if (spawn.inheritsSystemRole && spawn.kyberionCapable && spawn.targets.length === 0) {
          addUnresolved(
            spawn.site,
            'child process may inherit SYSTEM_ROLE and its entry point could not be resolved'
          );
        }
      }
    }
    // DR-01: delegations issued for a child under THIS system role by an env
    // literal that sets SYSTEM_ROLE, wherever the spawning code lives.
    for (const delegation of analyzer.foreignDelegations) {
      if (!delegation.anySystemRole && !delegation.systemRoles.has(systemRole)) continue;
      for (const role of [...delegation.roles].sort()) {
        reachable[role] ??= { example_path: [delegation.site] };
      }
      for (const reason of delegation.unresolved) addUnresolved(delegation.site, reason);
    }
    // A child entry the program does not hold cannot be walked: any role.
    for (const rel of entryFiles) {
      if (!program.getSourceFile(ws.abs(rel))) {
        addUnresolved(rel, 'child process entry point is outside the analysed program');
      }
    }
    const allowed = new Set([
      ...(policy.shared_core_roles?.roles ?? []),
      ...(policy.system_roles?.[systemRole]?.may_assume ?? []),
    ]);
    systemRoles[systemRole] = {
      entries: files.map((file) => ws.rel(file)).sort(),
      reviewed_infeasible: reviewedInfeasible.sort((a, b) =>
        compareCodeUnits(`${a.role}|${a.site}`, `${b.role}|${b.site}`)
      ),
      child_process_entries: childEntries.sort((a, b) => compareCodeUnits(a.site, b.site)),
      reachable_roles: Object.fromEntries(
        Object.entries(reachable).sort(([a], [b]) => compareCodeUnits(a, b))
      ),
      unresolved_sites: [...unresolved].sort(),
      // An unresolved site may assume any role: nothing is provably unreachable.
      policy_roles_not_reachable:
        unresolved.size > 0
          ? []
          : [...allowed].filter((role) => role !== systemRole && !reachable[role]).sort(),
    };
  }

  const siteMap = new Map<string, AssumptionSiteReport>();
  for (const record of analyzer.roleRecords) {
    const existing = siteMap.get(record.site) ?? { site: record.site, roles: [], unresolved: [] };
    existing.roles = [...new Set([...existing.roles, ...record.roles])].sort();
    existing.unresolved = [...new Set([...existing.unresolved, ...record.unresolved])].sort();
    siteMap.set(record.site, existing);
  }

  return {
    version: 1,
    generated_by: 'scripts/analyze_role_assumptions.ts',
    description:
      'RN-02 call-level reachability of in-process role assumptions per SYSTEM_ROLE. Computed in memory by `node --import ./scripts/ts-loader.mjs scripts/analyze_role_assumptions.ts --write-report` (not committed); see knowledge/product/governance/AUTHORITY_MODEL.md section 3.B2.',
    assumption_sites: [...siteMap.values()].sort((a, b) => compareCodeUnits(a.site, b.site)),
    unresolved_sites: Object.fromEntries(
      [...unresolvedSites.entries()]
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([site, reasons]) => [site, [...reasons].sort()])
    ),
    system_roles: systemRoles,
  };
}

export function renderReachabilityReport(report: RoleAssumptionReachabilityReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * System roles whose grants RN-03 narrowed on the report's evidence. Their
 * narrowing is only sound while the analysis can prove unreachability, so a
 * new any-role site or an inheriting child process must force a re-review.
 */
export const NARROWED_SYSTEM_ROLES: readonly string[] = [
  'oauth_callback_surface',
  'surface_runtime',
];

export interface RoleAssumptionViolation {
  rule:
    | 'reachable-role-not-granted'
    | 'policy-role-not-analysed'
    | 'analysed-role-not-in-policy'
    | 'launched-role-not-analysed'
    | 'narrowed-role-unresolved';
  system_role: string;
  message: string;
}

const POLICY_HINT = `grant it in ${POLICY_PATH} (system_roles.<role>.may_assume, with a rationale) or remove the assumption`;

/**
 * The RN-03 invariants the `role-assumption-reachability` gate enforces on an
 * in-memory report:
 *  - every reachable role is granted to its system role (the role itself,
 *    shared_core_roles, or system_roles.<role>.may_assume), so code that adds
 *    an assumption fails CI instead of [ROLE_ASSUMPTION_DENIED] in production;
 *  - the analysis covers exactly the system roles the policy governs;
 *  - every SYSTEM_ROLE a package script launches is analysed;
 *  - every narrowed system role stays fully resolved (no any-role site, no
 *    child process inheriting SYSTEM_ROLE).
 */
export function checkReachabilityInvariants(
  report: RoleAssumptionReachabilityReport,
  policy: RoleAssumptionPolicyFile,
  packageScripts: Record<string, string> = {}
): RoleAssumptionViolation[] {
  const violations: RoleAssumptionViolation[] = [];
  const analysed = Object.keys(report.system_roles).sort();
  const governed = Object.keys(policy.system_roles ?? {}).sort();
  for (const systemRole of analysed) {
    const entry = report.system_roles[systemRole]!;
    const allowed = new Set([
      systemRole,
      ...(policy.shared_core_roles?.roles ?? []),
      ...(policy.system_roles?.[systemRole]?.may_assume ?? []),
    ]);
    for (const [role, reach] of Object.entries(entry.reachable_roles)) {
      if (allowed.has(role)) continue;
      violations.push({
        rule: 'reachable-role-not-granted',
        system_role: systemRole,
        message: `${systemRole} can assume ${role} but the policy does not grant it — via ${reach.example_path.join(' -> ')} | next: ${POLICY_HINT}`,
      });
    }
    if (!governed.includes(systemRole)) {
      violations.push({
        rule: 'analysed-role-not-in-policy',
        system_role: systemRole,
        message: `${systemRole} has entry points (${entry.entries.join(', ')}) but no system_roles entry in ${POLICY_PATH} | next: add it with the roles it may assume`,
      });
    }
  }
  for (const systemRole of governed) {
    if (analysed.includes(systemRole)) continue;
    violations.push({
      rule: 'policy-role-not-analysed',
      system_role: systemRole,
      message: `${systemRole} is governed by ${POLICY_PATH} but the analysis found no entry point for it | next: remove the stale policy entry or register its surface/launcher`,
    });
  }
  const launched = new Set(
    Object.values(packageScripts).flatMap((command) =>
      [...command.matchAll(/\bSYSTEM_ROLE=([a-z0-9_]+)/g)].map((match) => match[1]!)
    )
  );
  for (const systemRole of [...launched].sort()) {
    if (report.system_roles[systemRole]) continue;
    violations.push({
      rule: 'launched-role-not-analysed',
      system_role: systemRole,
      message: `a package.json script launches SYSTEM_ROLE=${systemRole} but the analysis has no entry point for it | next: add it to ${POLICY_PATH} and make its entry discoverable (scripts/lib/role-assumption-workspace.ts)`,
    });
  }
  for (const systemRole of NARROWED_SYSTEM_ROLES) {
    const entry = report.system_roles[systemRole];
    if (!entry) continue;
    const reasons = [
      ...entry.unresolved_sites.map((site) => `any-role site ${site}`),
      ...entry.child_process_entries.map(
        (child) => `child process ${child.site} inherits SYSTEM_ROLE`
      ),
    ];
    if (reasons.length === 0) continue;
    violations.push({
      rule: 'narrowed-role-unresolved',
      system_role: systemRole,
      message: `${systemRole} had its grants narrowed (RN-03) but is no longer fully resolved: ${reasons.join('; ')} | next: resolve the site or re-review the narrowed grants`,
    });
  }
  return violations;
}

export function formatViolations(violations: readonly RoleAssumptionViolation[]): string {
  return [
    `${violations.length} RN-03 invariant violation(s):`,
    ...violations.map((violation) => `  - [${violation.rule}] ${violation.message}`),
    `evidence: rerun with --write-report for the full report (active/shared/cache/system/role-assumption/reachability.json); see knowledge/product/governance/AUTHORITY_MODEL.md section 3.B2`,
  ].join('\n');
}

/** Build the report for `root` and check it against that checkout's policy and package.json. */
export function evaluateReachabilityGate(root: string = pathResolver.rootDir()): {
  report: RoleAssumptionReachabilityReport;
  violations: RoleAssumptionViolation[];
} {
  const report = buildReachabilityReport(root);
  const policy = readSafeJsonFile<RoleAssumptionPolicyFile>(
    path.join(root, POLICY_PATH),
    'role assumption policy'
  );
  const packageJson = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    path.join(root, 'package.json'),
    'package.json'
  );
  return {
    report,
    violations: checkReachabilityInvariants(report, policy, packageJson.scripts ?? {}),
  };
}

/** `--help` / typos exit before the ~100s analysis starts. */
export const ROLE_ASSUMPTION_REACHABILITY_CLI: CliGuardSpec = {
  command: 'node --import ./scripts/ts-loader.mjs scripts/analyze_role_assumptions.ts',
  options: [
    { flag: '--write-report' },
    { flag: '--check' },
    { flag: '--json' },
    { flag: '--quiet' },
  ],
};

export const main = defineScript({
  name: 'role-assumption-reachability',
  flags: ['json', 'quiet', 'check'],
  async run(context) {
    if (guardCliArgs(context.argv, ROLE_ASSUMPTION_REACHABILITY_CLI, context.print))
      return undefined;
    const { report, violations } = evaluateReachabilityGate();
    if (hasCliFlag(context.argv, '--write-report')) {
      const output = reachabilityReportPath();
      safeMkdir(path.dirname(output), { recursive: true });
      safeWriteFile(output, renderReachabilityReport(report));
      context.print(`[role-assumption-reachability] report written to ${output}`);
    }
    if (violations.length > 0) {
      throw new ScriptExitError(1, formatViolations(violations), false, { violations });
    }
    const systemRoles = Object.keys(report.system_roles).length;
    context.print(
      context.json
        ? { status: 'ok', system_roles: systemRoles, violations: [] }
        : `[role-assumption-reachability] OK — ${systemRoles} system role(s); every reachable role is granted`
    );
    return { status: 'ok', violations: [] };
  },
});

if (
  isDirectScript(import.meta.url, 'analyze_role_assumptions.ts') ||
  isDirectScript(import.meta.url, 'analyze_role_assumptions.js')
) {
  void main();
}
