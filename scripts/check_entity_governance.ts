/** EG-09/12: cross-entity drift and boundary conformance checker. */
import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeExecResult,
  safeStat,
  listProjectRecords,
  withExecutionContext,
} from '@agent/core';
import { getRegisteredEnvText, readJson } from '@agent/core/foundation';
import { runCheck as runTenantRegistryCheck } from './check_tenant_registry_consistency.js';

export interface EntityGovernanceReport {
  status: 'ok' | 'drift';
  violations: string[];
  warnings: string[];
  scopes: { organizations: string[]; projects: string[]; missions: string[] };
  retention: { missing_declarations: string[] };
  workspace_registry: { missing: string[]; unregistered: string[] };
  mission_hygiene: { non_tier_roots: string[]; duplicate_ids: string[]; invalid_ids: string[] };
  git_boundaries: { violations: string[]; tracked_ignored: string[] };
  plan_ledger: { missing: string[] };
}

export function shouldFailEntityGovernance(
  report: Pick<EntityGovernanceReport, 'status' | 'warnings'>,
  strictWarnings = false
): boolean {
  return report.status === 'drift' || (strictWarnings && report.warnings.length > 0);
}

const REQUIRED_PROTECTED_PREFIXES = [
  'active/missions/confidential/',
  'active/projects/confidential/',
];
const REQUIRED_RETENTION_PATHS = [
  'active/shared/runtime/mesh-hub',
  'active/shared/runtime/pipeline-runs',
  'active/shared/runtime/run-graphs',
];

function childDirectories(root: string): string[] {
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root).filter((entry) => {
    try {
      return safeStat(path.join(root, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function collectScopedDirectories(root: string): string[] {
  const result: string[] = [];
  for (const tier of ['personal', 'confidential', 'public']) {
    const tierRoot = path.join(root, tier);
    for (const tenantOrId of childDirectories(tierRoot)) {
      const candidate = path.join(tierRoot, tenantOrId);
      for (const entity of childDirectories(candidate)) {
        result.push(path.relative(root, path.join(candidate, entity)).replaceAll(path.sep, '/'));
      }
    }
  }
  return result.sort();
}

function collectMissionDirectories(root: string): string[] {
  const result: string[] = [];
  for (const tier of ['personal', 'confidential', 'public']) {
    const tierRoot = path.join(root, tier);
    for (const entry of childDirectories(tierRoot)) {
      const candidate = path.join(tierRoot, entry);
      const looksLikeMission =
        safeExistsSync(path.join(candidate, 'mission-state.json')) ||
        safeExistsSync(path.join(candidate, '.git'));
      if (looksLikeMission) {
        result.push(path.relative(root, candidate).replaceAll(path.sep, '/'));
        continue;
      }
      for (const mission of childDirectories(candidate)) {
        const missionPath = path.join(candidate, mission);
        if (
          safeExistsSync(path.join(missionPath, 'mission-state.json')) ||
          safeExistsSync(path.join(missionPath, '.git'))
        ) {
          result.push(path.relative(root, missionPath).replaceAll(path.sep, '/'));
        }
      }
    }
  }
  return result.sort();
}

function collectTrackedIgnoredBoundaries(rootDir: string): string[] {
  if (path.resolve(rootDir) !== path.resolve(pathResolver.rootDir())) return [];
  const result = safeExecResult(
    'git',
    ['ls-files', '--ignored', '--exclude-standard', '--cached'],
    { cwd: rootDir }
  );
  if (result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry === 'vault/mounts/.gitkeep' || entry.startsWith('knowledge/personal/'))
    .sort();
}

function collectPlanLedgerGaps(rootDir: string): string[] {
  if (path.resolve(rootDir) !== path.resolve(pathResolver.rootDir())) return [];
  const planDir = path.join(rootDir, 'docs/developer/improvement-plans-2026-07');
  const statusPath = path.join(planDir, 'STATUS.ja.md');
  if (!safeExistsSync(statusPath)) return ['STATUS.ja.md'];
  const status = String(safeReadFile(statusPath, { encoding: 'utf8' }));
  return safeReaddir(planDir)
    .filter((entry) => entry.endsWith('.ja.md'))
    .filter((entry) => !['README.ja.md', 'STATUS.ja.md'].includes(entry))
    .filter((entry) => !/^REVIEW_|^IMPL_REVIEW_/.test(entry))
    .filter((entry) => {
      const stem = entry.slice(0, -'.ja.md'.length);
      const id = stem.match(/^([A-Z]+-\d+)/)?.[1];
      return id ? !new RegExp(`\\|\\s*${id}\\s*\\|`).test(status) : !status.includes(entry);
    })
    .sort();
}

export function collectEntityGovernanceReport(
  rootDir = pathResolver.rootDir()
): EntityGovernanceReport {
  const violations: string[] = [];
  const warnings: string[] = [];
  const policyPath = path.join(rootDir, 'knowledge/product/governance/security-policy.json');
  const schemaPath = path.join(rootDir, 'schemas/work-item.schema.json');
  const catalogPath = path.join(
    rootDir,
    'knowledge/product/governance/storage-retention-catalog.json'
  );
  let policy: any = null;
  let catalog: any = null;
  try {
    policy = readJson<unknown>(policyPath);
  } catch (error) {
    violations.push(`security policy unreadable: ${String(error)}`);
  }
  try {
    catalog = readJson<unknown>(catalogPath);
  } catch (error) {
    violations.push(`retention catalog unreadable: ${String(error)}`);
  }
  for (const prefix of REQUIRED_PROTECTED_PREFIXES) {
    if (!policy?.tenant_scope?.protected_prefixes?.includes(prefix)) {
      violations.push(`security policy missing protected prefix '${prefix}'`);
    }
  }
  if (!safeExistsSync(schemaPath)) violations.push('work-item.schema.json is missing');
  const declaredRetention = new Set((catalog?.entries || []).map((entry: any) => entry.path));
  const missingDeclarations = REQUIRED_RETENTION_PATHS.filter(
    (entry) => !declaredRetention.has(entry)
  );
  if (missingDeclarations.length)
    warnings.push(`runtime retention declarations missing: ${missingDeclarations.join(', ')}`);
  const tenantCheck = withExecutionContext(
    'sovereign',
    () => runTenantRegistryCheck({ rootDir }),
    'sovereign'
  );
  if (tenantCheck.exitCode !== 0) violations.push('tenant registry drift detected');
  const scopes = {
    organizations: collectScopedDirectories(path.join(rootDir, 'active/organizations')),
    projects: collectScopedDirectories(path.join(rootDir, 'active/projects')),
    missions: collectMissionDirectories(path.join(rootDir, 'active/missions')),
  };
  const projectWorkspaceMissing: string[] = [];
  const registeredProjectIds = new Set<string>();
  const projectWorkspaceRoots = new Set<string>();
  if (path.resolve(rootDir) === path.resolve(pathResolver.rootDir())) {
    for (const project of listProjectRecords()) {
      if (project.status === 'archived') continue;
      registeredProjectIds.add(project.project_id);
      const workspace = pathResolver.projectWorkspaceDir(
        project.project_id,
        project.tier,
        project.tenant_slug || 'shared'
      );
      projectWorkspaceRoots.add(path.resolve(workspace));
      if (!safeExistsSync(workspace)) projectWorkspaceMissing.push(project.project_id);
    }
  }
  const unregisteredProjectWorkspaces: string[] = [];
  for (const relative of scopes.projects) {
    const parts = relative.split('/');
    if (parts.length !== 3) continue;
    const projectId = parts[2];
    const absolute = pathResolver.rootResolve(path.join('active/projects', relative));
    if (
      !registeredProjectIds.has(projectId) &&
      !projectWorkspaceRoots.has(path.resolve(absolute))
    ) {
      unregisteredProjectWorkspaces.push(relative);
    }
  }
  const legacyMissionRoot = path.join(rootDir, 'active/missions');
  const missionNonTierRoots = childDirectories(legacyMissionRoot).filter(
    (entry) => !['personal', 'confidential', 'public', 'ephemeral'].includes(entry)
  );
  for (const entry of missionNonTierRoots) {
    violations.push(`mission tree contains non-tier root '${entry}'`);
  }
  const missionLocations = new Map<string, string[]>();
  for (const relative of scopes.missions) {
    const id = relative.split('/').at(-1);
    if (!id) continue;
    const locations = missionLocations.get(id) || [];
    locations.push(relative);
    missionLocations.set(id, locations);
  }
  const duplicateMissionIds = [...missionLocations.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([id, locations]) => `${id}: ${locations.join(', ')}`)
    .sort();
  const invalidMissionIds = scopes.missions
    .map((relative) => relative.split('/').at(-1) || '')
    .filter((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(id) || id.startsWith('--'))
    .sort();
  for (const id of invalidMissionIds) {
    violations.push(`mission tree contains invalid mission id '${id}'`);
  }
  const gitBoundaryViolations: string[] = [];
  const trackedIgnored = collectTrackedIgnoredBoundaries(rootDir);
  const planLedgerMissing = collectPlanLedgerGaps(rootDir);
  const gitIgnorePath = path.join(rootDir, '.gitignore');
  if (safeExistsSync(gitIgnorePath)) {
    const gitIgnore = String(safeReadFile(gitIgnorePath, { encoding: 'utf8' }));
    if (/^\*\.jsonl$/m.test(gitIgnore))
      gitBoundaryViolations.push('global *.jsonl ignore rule remains');
    if ((gitIgnore.match(/^active\/$/gm) || []).length > 1)
      gitBoundaryViolations.push('duplicate active/ ignore rule remains');
    if (/knowledge\/evolution\/distill_\*\.md/.test(gitIgnore))
      gitBoundaryViolations.push('distill artifacts remain globally ignored');
  }
  if (trackedIgnored.length) {
    gitBoundaryViolations.push(
      `tracked files still match governed ignore boundaries: ${trackedIgnored.join(', ')}`
    );
  }
  if (planLedgerMissing.length) {
    violations.push(`plan ledger missing registrations: ${planLedgerMissing.join(', ')}`);
  }
  for (const boundaryViolation of gitBoundaryViolations) {
    violations.push(`git boundary: ${boundaryViolation}`);
  }
  if (projectWorkspaceMissing.length)
    warnings.push(`registered project workspaces missing: ${projectWorkspaceMissing.join(', ')}`);
  if (unregisteredProjectWorkspaces.length)
    warnings.push(
      `unregistered project workspaces found: ${unregisteredProjectWorkspaces.join(', ')}`
    );
  if (duplicateMissionIds.length)
    warnings.push(`duplicate mission ids found: ${duplicateMissionIds.join('; ')}`);
  return {
    status: violations.length ? 'drift' : 'ok',
    violations,
    warnings,
    scopes,
    retention: { missing_declarations: missingDeclarations },
    workspace_registry: {
      missing: projectWorkspaceMissing.sort(),
      unregistered: unregisteredProjectWorkspaces.sort(),
    },
    mission_hygiene: {
      non_tier_roots: missionNonTierRoots.sort(),
      duplicate_ids: duplicateMissionIds,
      invalid_ids: invalidMissionIds,
    },
    git_boundaries: { violations: gitBoundaryViolations, tracked_ignored: trackedIgnored },
    plan_ledger: { missing: planLedgerMissing },
  };
}

export function main(): void {
  const report = withExecutionContext(
    'sovereign',
    () => collectEntityGovernanceReport(),
    'sovereign'
  );
  console.log(JSON.stringify(report, null, 2));
  const strictWarnings =
    process.argv.includes('--strict-warnings') ||
    getRegisteredEnvText('KYBERION_ENTITY_GOVERNANCE_STRICT_WARNINGS') === 'true';
  if (shouldFailEntityGovernance(report, strictWarnings)) process.exitCode = 1;
}

if (
  process.argv[1]?.endsWith('check_entity_governance.ts') ||
  process.argv[1]?.endsWith('check_entity_governance.js')
)
  main();
