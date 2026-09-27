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
 * The report is checked in at docs/developer/role-assumption-reachability.json.
 * `--check` (the `role-assumption-reachability` CI gate) fails when it is
 * stale; scripts/analyze_role_assumptions.contract.test.ts fails when a
 * reachable role is missing from role-assumption-policy.json.
 */
import * as path from 'node:path';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { defineGenerator, isDirectScript } from './lib/harness.js';
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

export const REACHABILITY_REPORT_PATH = 'docs/developer/role-assumption-reachability.json';
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

interface PolicyFile {
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
  const policy = readSafeJsonFile<PolicyFile>(
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
      'RN-02 call-level reachability of in-process role assumptions per SYSTEM_ROLE. Regenerate with `node --import ./scripts/ts-loader.mjs scripts/analyze_role_assumptions.ts`; see knowledge/product/governance/AUTHORITY_MODEL.md section 3.B2.',
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

/** Compare reports by content so formatter (prettier) layout never reads as staleness. */
/** Fields that only illustrate a path and depend on graph traversal order. */
const ORDER_SENSITIVE_FIELDS = new Set(['example_path']);

function stripOrderSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOrderSensitive);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !ORDER_SENSITIVE_FIELDS.has(key))
      .map(([key, entry]) => [key, stripOrderSensitive(entry)])
  );
}

/**
 * The staleness comparison (`--check`): by content, not layout, and without
 * the illustrative example paths, so an unrelated refactor that only changes
 * which path the BFS finds first does not fail the gate. Roles, sites,
 * unresolved sites and child-process entries are compared.
 */
export function normalizeReachabilityReport(content: string): string {
  try {
    return JSON.stringify(
      stripOrderSensitive(parseSafeJsonInput(content, 'role assumption reachability report'))
    );
  } catch {
    return content;
  }
}

export const main = defineGenerator({
  id: 'role-assumption-reachability',
  outputs: [REACHABILITY_REPORT_PATH],
  normalize: normalizeReachabilityReport,
  render() {
    return [
      {
        path: REACHABILITY_REPORT_PATH,
        content: renderReachabilityReport(buildReachabilityReport()),
      },
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'analyze_role_assumptions.ts') ||
  isDirectScript(import.meta.url, 'analyze_role_assumptions.js')
) {
  void main();
}
