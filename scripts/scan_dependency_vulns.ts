import * as path from 'node:path';
import {
  logger,
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeReadFile,
  safeJsonParse,
  type PatchDecision,
  decidePatchAction,
} from '@agent/core';
import { safeReaddir, safeLstat } from '@agent/core';

type AuditVulnEntry = {
  name?: string;
  severity?: string;
  via?: unknown;
  effects?: string[];
  nodes?: string[];
  range?: string;
  fixAvailable?: boolean | { name?: string; version?: string };
};

type AuditJson = {
  vulnerabilities?: Record<string, AuditVulnEntry>;
  metadata?: { vulnerabilities?: Record<string, number> };
};

type OutdatedJson = Record<
  string,
  {
    current?: string;
    wanted?: string;
    latest?: string;
    dependent?: string;
    location?: string;
  }
>;

export interface DependencyVulnerabilityFinding {
  package_name: string;
  severity: string;
  current_version?: string;
  latest_version?: string;
  reachability: 0 | 1 | 2;
  decision: PatchDecision;
  reason: string;
  reevaluate_when: string;
}

export interface DependencyVulnerabilityScanResult {
  timestamp: string;
  scanned_packages: number;
  findings: DependencyVulnerabilityFinding[];
}

const DEFAULT_LEDGER_PATH = pathResolver.active('shared/runtime/vuln-ledger.jsonl');

function readJson<T>(text: string, label: string): T {
  const trimmed = String(text || '').trim();
  if (!trimmed) return {} as T;
  try {
    return safeJsonParse<T>(trimmed, label);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return safeJsonParse<T>(trimmed.slice(start, end + 1), label);
    }
    return {} as T;
  }
}

function addWorkspacePackageJson(files: Set<string>, dir: string): void {
  const pkgPath = path.join(dir, 'package.json');
  try {
    if (safeExistsSync(pkgPath) && safeLstat(pkgPath).isFile()) files.add(pkgPath);
  } catch {
    return;
  }
}

function addDirectChildPackageJsons(
  files: Set<string>,
  parentDir: string,
  predicate?: (entry: string) => boolean
): void {
  try {
    if (!safeExistsSync(parentDir) || !safeLstat(parentDir).isDirectory()) return;
    for (const entry of safeReaddir(parentDir)) {
      if (predicate && !predicate(entry)) continue;
      const abs = path.join(parentDir, entry);
      try {
        if (!safeLstat(abs).isDirectory()) continue;
      } catch {
        continue;
      }
      addWorkspacePackageJson(files, abs);
    }
  } catch {
    return;
  }
}

function listWorkspacePackageJsonFiles(rootDir: string): string[] {
  const files = new Set<string>();
  addWorkspacePackageJson(files, rootDir);
  addWorkspacePackageJson(files, path.join(rootDir, 'libs', 'core'));
  addDirectChildPackageJsons(files, path.join(rootDir, 'libs'), (entry) =>
    entry.startsWith('shared-')
  );
  addDirectChildPackageJsons(files, path.join(rootDir, 'libs', 'actuators'));
  addDirectChildPackageJsons(files, path.join(rootDir, 'satellites'));
  addDirectChildPackageJsons(files, path.join(rootDir, 'presence', 'displays'));
  addDirectChildPackageJsons(files, path.join(rootDir, 'presence', 'bridge'));
  return [...files];
}

function collectWorkspaceDependencyNames(rootDir = pathResolver.rootDir()): Set<string> {
  const names = new Set<string>();
  for (const file of listWorkspacePackageJsonFiles(rootDir)) {
    try {
      const pkg = readJson<{
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      }>(safeReadFile(file, { encoding: 'utf8' }) as string, `package.json at ${file}`);
      for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
        for (const dep of Object.keys(section || {})) names.add(dep);
      }
    } catch {
      continue;
    }
  }
  return names;
}

function normalizeSeverity(value: unknown): string {
  const severity = String(value || 'low').toLowerCase();
  if (
    severity === 'critical' ||
    severity === 'high' ||
    severity === 'moderate' ||
    severity === 'low'
  ) {
    return severity;
  }
  return 'low';
}

function severityToScore(severity: string): number {
  switch (severity) {
    case 'critical':
      return 3;
    case 'high':
      return 2;
    case 'moderate':
      return 1;
    default:
      return 0;
  }
}

function inferReachability(
  packageName: string,
  workspaceDeps: Set<string>,
  auditEntry: AuditVulnEntry
): 0 | 1 | 2 {
  if (workspaceDeps.has(packageName)) return 2;
  if (Array.isArray(auditEntry.nodes) && auditEntry.nodes.length > 0) return 1;
  if (Array.isArray(auditEntry.effects) && auditEntry.effects.length > 0) return 1;
  return 0;
}

function inferAttackSurface(reachability: 0 | 1 | 2): number {
  return reachability === 2 ? 2 : reachability === 1 ? 1 : 0;
}

function inferSemverJump(currentVersion?: string, latestVersion?: string): number {
  if (!currentVersion || !latestVersion) return 1;
  if (currentVersion === latestVersion) return 0;
  const currentMajor = Number((currentVersion.match(/^(\d+)/) || [])[1] || 0);
  const latestMajor = Number((latestVersion.match(/^(\d+)/) || [])[1] || 0);
  if (latestMajor > currentMajor) return 3;
  const currentMinor = Number((currentVersion.match(/^\d+\.(\d+)/) || [])[1] || 0);
  const latestMinor = Number((latestVersion.match(/^\d+\.(\d+)/) || [])[1] || 0);
  if (latestMinor > currentMinor) return 1;
  return 0;
}

function inferTestGap(reachability: 0 | 1 | 2): number {
  return reachability === 2 ? 2 : reachability === 1 ? 1 : 0;
}

function inferRollbackDifficulty(severity: string): number {
  return severity === 'critical' ? 3 : severity === 'high' ? 2 : severity === 'moderate' ? 1 : 0;
}

function parseAuditJson(raw: string): AuditJson {
  return readJson<AuditJson>(raw, 'pnpm audit json');
}

function parseOutdatedJson(raw: string): OutdatedJson {
  return readJson<OutdatedJson>(raw, 'pnpm outdated json');
}

export function scanDependencyVulnerabilitiesFromInputs(input: {
  auditJson: string;
  outdatedJson: string;
  workspaceRoot?: string;
  ledgerPath?: string;
}): DependencyVulnerabilityScanResult {
  const audit = parseAuditJson(input.auditJson);
  const outdated = parseOutdatedJson(input.outdatedJson);
  const workspaceDeps = collectWorkspaceDependencyNames(
    input.workspaceRoot || pathResolver.rootDir()
  );
  const findings: DependencyVulnerabilityFinding[] = [];

  for (const [packageName, vuln] of Object.entries(audit.vulnerabilities || {})) {
    const severity = normalizeSeverity(vuln.severity);
    const reachability = inferReachability(packageName, workspaceDeps, vuln);
    const latestVersion = outdated[packageName]?.latest;
    const currentVersion = outdated[packageName]?.current;
    const decision = decidePatchAction({
      severity: severityToScore(severity),
      reachability,
      attackSurface: inferAttackSurface(reachability),
      semverJump: inferSemverJump(currentVersion, latestVersion),
      testGap: inferTestGap(reachability),
      rollbackDifficulty: inferRollbackDifficulty(severity),
    }).decision;

    findings.push({
      package_name: packageName,
      severity,
      current_version: currentVersion,
      latest_version: latestVersion,
      reachability,
      decision,
      reason:
        decision === 'defer'
          ? 'Low urgency and elevated apply risk'
          : decision === 'urgent_approval'
            ? 'High urgency with elevated apply risk'
            : 'Patch decision evaluated from audit metadata',
      reevaluate_when: latestVersion
        ? `When ${packageName} updates beyond ${latestVersion}`
        : 'On next daily scan',
    });
  }

  const result: DependencyVulnerabilityScanResult = {
    timestamp: new Date().toISOString(),
    scanned_packages: Object.keys(audit.vulnerabilities || {}).length,
    findings,
  };

  const ledgerPath = input.ledgerPath || DEFAULT_LEDGER_PATH;
  safeMkdir(path.dirname(ledgerPath), { recursive: true });
  safeAppendFileSync(ledgerPath, `${JSON.stringify(result)}\n`);
  return result;
}

async function runScan(): Promise<number> {
  const audit = safeExecResult('pnpm', ['audit', '--json'], { maxOutputMB: 20 });
  const outdated = safeExecResult('pnpm', ['outdated', '--json'], { maxOutputMB: 20 });

  const result = scanDependencyVulnerabilitiesFromInputs({
    auditJson: audit.stdout || '{}',
    outdatedJson: outdated.stdout || '{}',
  });

  logger.info(
    `[vuln-scan] scanned ${result.scanned_packages} package(s), findings=${result.findings.length}`
  );
  if (result.findings.length > 0) {
    logger.warn('[vuln-scan] findings appended to vuln ledger');
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

const isDirect = process.argv[1] && /scan_dependency_vulns\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  runScan().then(
    (code) => process.exit(code),
    (error) => {
      logger.error(`[vuln-scan] failed: ${(error as Error).message || error}`);
      process.exit(1);
    }
  );
}

export { runScan };
