#!/usr/bin/env node
import * as path from 'node:path';
import {
  logger,
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeLstat,
  safeExecResult,
  type PatchDecisionKind,
} from '@agent/core';
import { decidePatchAction, type PatchDecisionInput } from '@agent/core/patch-decision';

type AuditVulnerabilityNode = {
  name?: string;
  severity?: string;
  via?: Array<string | { source?: string; name?: string; title?: string; severity?: string; url?: string }>;
  effects?: string[];
  range?: string;
  fixAvailable?: boolean | { name?: string; version?: string; isSemVerMajor?: boolean };
  nodes?: string[];
};

type AuditJson = {
  vulnerabilities?: Record<string, AuditVulnerabilityNode>;
};

type OutdatedEntry = {
  current?: string;
  wanted?: string;
  latest?: string;
};

type OutdatedJson = Record<string, OutdatedEntry> | OutdatedEntry[];

export type DependencyReachability = 'none' | 'transitive' | 'direct';

export interface DependencyVulnerabilityFinding {
  packageName: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  currentVersion: string | null;
  wantedVersion: string | null;
  latestVersion: string | null;
  reachability: DependencyReachability;
  attackSurface: 'local' | 'internal' | 'external';
  semverJump: 'patch' | 'minor' | 'major';
  testGap: 'covered' | 'partial' | 'thin';
  rollbackDifficulty: 'easy' | 'moderate' | 'hard';
  decision: PatchDecisionKind;
  state: 'open' | 'patched' | 'deferred' | 'escalated';
  cveIds: string[];
  advisories: string[];
  reasons: string[];
  reEvaluateWhen: string[];
}

export interface DependencyVulnScanReport {
  scannedAt: string;
  findings: DependencyVulnerabilityFinding[];
  ledgerPath: string;
  wroteLedger: boolean;
}

export interface DependencyVulnScanOptions {
  rootDir?: string;
  ledgerPath?: string;
  auditJson?: string;
  outdatedJson?: string;
  writeLedger?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJsonMaybe(filePath: string): string | null {
  if (!safeExistsSync(filePath)) return null;
  return String(safeReadFile(filePath, { encoding: 'utf8' }));
}

function workspacePackageJsonPaths(rootDir: string): string[] {
  const results: string[] = [];
  const queue: string[] = [rootDir];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (!safeExistsSync(current)) continue;
    const entries = safeReaddir(current);
    for (const entry of entries) {
      const full = path.join(current, entry);
      const stat = safeLstat(full);
      if (!stat.isDirectory()) continue;
      if (entry === 'node_modules' || entry === 'dist' || entry === 'active' || entry === 'docs') {
        continue;
      }
      const packageJson = path.join(full, 'package.json');
      if (safeExistsSync(packageJson)) results.push(packageJson);
      queue.push(full);
    }
  }
  return results;
}

function collectDirectDependencyNames(rootDir: string): Set<string> {
  const names = new Set<string>();
  const packageJsonPaths = [path.join(rootDir, 'package.json'), ...workspacePackageJsonPaths(rootDir)];
  for (const packageJsonPath of packageJsonPaths) {
    if (!safeExistsSync(packageJsonPath)) continue;
    try {
      const pkg = parseJson<Record<string, unknown>>(
        String(safeReadFile(packageJsonPath, { encoding: 'utf8' })),
        packageJsonPath
      );
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = pkg[field];
        if (!isObject(deps)) continue;
        for (const name of Object.keys(deps)) names.add(name);
      }
    } catch (error) {
      logger.warn(`[scan_dependency_vulns] failed to read ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return names;
}

function asObjectEntries(raw: OutdatedJson): Array<[string, OutdatedEntry]> {
  if (Array.isArray(raw)) {
    return raw
      .map((entry, index) => [String((entry as any)?.name ?? index), entry] as [string, OutdatedEntry])
      .filter(([, entry]) => isObject(entry));
  }
  return Object.entries(raw);
}

function parseVersionParts(version: string | null | undefined): number[] | null {
  if (!version) return null;
  const match = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function classifySemverJump(currentVersion: string | null, latestVersion: string | null): 'patch' | 'minor' | 'major' {
  const current = parseVersionParts(currentVersion);
  const latest = parseVersionParts(latestVersion);
  if (!current || !latest) return currentVersion === latestVersion ? 'patch' : 'minor';
  if (latest[0] > current[0]) return 'major';
  if (latest[1] > current[1]) return 'minor';
  if (latest[2] > current[2]) return 'patch';
  return 'patch';
}

function mapSeverity(severity: string | undefined): 'low' | 'moderate' | 'high' | 'critical' {
  const lowered = String(severity || '').toLowerCase();
  if (lowered === 'critical') return 'critical';
  if (lowered === 'high') return 'high';
  if (lowered === 'moderate' || lowered === 'medium') return 'moderate';
  return 'low';
}

function deriveReachability(packageName: string, directDependencies: Set<string>): DependencyReachability {
  if (directDependencies.has(packageName)) return 'direct';
  if (directDependencies.size > 0) return 'transitive';
  return 'none';
}

function deriveAttackSurface(reachability: DependencyReachability): 'local' | 'internal' | 'external' {
  if (reachability === 'direct') return 'external';
  if (reachability === 'transitive') return 'internal';
  return 'local';
}

function deriveTestGap(reachability: DependencyReachability): 'covered' | 'partial' | 'thin' {
  if (reachability === 'direct') return 'partial';
  if (reachability === 'transitive') return 'thin';
  return 'covered';
}

function deriveRollbackDifficulty(semverJump: 'patch' | 'minor' | 'major'): 'easy' | 'moderate' | 'hard' {
  if (semverJump === 'major') return 'hard';
  if (semverJump === 'minor') return 'moderate';
  return 'easy';
}

function parseAuditFindings(
  audit: AuditJson,
  outdated: Map<string, OutdatedEntry>,
  directDependencies: Set<string>
): DependencyVulnerabilityFinding[] {
  const findings: DependencyVulnerabilityFinding[] = [];
  for (const [packageName, vulnerability] of Object.entries(audit.vulnerabilities ?? {})) {
    const currentVersion = outdated.get(packageName)?.current ?? null;
    const wantedVersion = outdated.get(packageName)?.wanted ?? null;
    const latestVersion = outdated.get(packageName)?.latest ?? null;
    const severity = mapSeverity(vulnerability.severity);
    const reachability = deriveReachability(packageName, directDependencies);
    const attackSurface = deriveAttackSurface(reachability);
    const semverJump = classifySemverJump(currentVersion, latestVersion);
    const testGap = deriveTestGap(reachability);
    const rollbackDifficulty = deriveRollbackDifficulty(semverJump);
    const patchDecision = decidePatchAction({
      severity,
      reachability: reachability === 'direct' ? 2 : reachability === 'transitive' ? 1 : 0,
      attackSurface: attackSurface === 'external' ? 3 : attackSurface === 'internal' ? 2 : 1,
      semverJump: semverJump === 'major' ? 3 : semverJump === 'minor' ? 2 : 1,
      testGap: testGap === 'thin' ? 3 : testGap === 'partial' ? 2 : 1,
      rollbackDifficulty:
        rollbackDifficulty === 'hard' ? 3 : rollbackDifficulty === 'moderate' ? 2 : 1,
    });
    const cveIds = (vulnerability.via ?? [])
      .map((via) => (typeof via === 'object' && via ? String(via.source ?? via.title ?? via.name ?? '') : ''))
      .filter((id) => /^CVE-/i.test(id));
    const advisories = (vulnerability.via ?? [])
      .map((via) =>
        typeof via === 'string'
          ? via
          : String(via.title ?? via.name ?? via.source ?? via.url ?? '').trim()
      )
      .filter(Boolean);
    const state =
      patchDecision.decision === 'auto_apply'
        ? 'open'
        : patchDecision.decision === 'defer'
          ? 'deferred'
          : patchDecision.decision === 'urgent_approval' || patchDecision.decision === 'approval'
            ? 'escalated'
            : 'open';
    const reasons = [
      `severity=${severity}`,
      `reachability=${reachability}`,
      `decision=${patchDecision.decision}`,
      `urgency=${patchDecision.urgency}`,
      `applyRisk=${patchDecision.applyRisk}`,
    ];
    const reEvaluateWhen = [
      latestVersion ? `latest_version_changes:${latestVersion}` : 'new_patch_available',
      `reachability_changes:${reachability}`,
      `severity_changes:${severity}`,
    ];
    findings.push({
      packageName,
      severity,
      currentVersion,
      wantedVersion,
      latestVersion,
      reachability,
      attackSurface,
      semverJump,
      testGap,
      rollbackDifficulty,
      decision: patchDecision.decision,
      state,
      cveIds,
      advisories,
      reasons,
      reEvaluateWhen,
    });
  }
  return findings;
}

function loadInputs(options: DependencyVulnScanOptions): { audit: AuditJson; outdated: Map<string, OutdatedEntry> } {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const auditRaw =
    options.auditJson ??
    readJsonMaybe(path.join(rootDir, 'active/shared/tmp/dependency-audit.json')) ??
    (() => {
      const result = safeExecResult('pnpm', ['audit', '--json'], { cwd: rootDir });
      if (result.status !== 0 && !result.stdout) {
        throw new Error(result.stderr || 'pnpm audit failed');
      }
      return String(result.stdout || result.stderr || '{}');
    })();
  const outdatedRaw =
    options.outdatedJson ??
    readJsonMaybe(path.join(rootDir, 'active/shared/tmp/dependency-outdated.json')) ??
    (() => {
      const result = safeExecResult('pnpm', ['outdated', '--json'], { cwd: rootDir });
      if (result.status !== 0 && !result.stdout) {
        throw new Error(result.stderr || 'pnpm outdated failed');
      }
      return String(result.stdout || result.stderr || '{}');
    })();
  const audit = parseJson<AuditJson>(auditRaw, 'pnpm audit json');
  const outdatedJson = parseJson<OutdatedJson>(outdatedRaw, 'pnpm outdated json');
  const outdated = new Map<string, OutdatedEntry>(asObjectEntries(outdatedJson));
  return { audit, outdated };
}

export function writeDependencyVulnLedger(
  findings: DependencyVulnerabilityFinding[],
  options: Pick<DependencyVulnScanOptions, 'ledgerPath' | 'rootDir'> = {}
): string {
  const ledgerPath =
    options.ledgerPath ?? pathResolver.shared('runtime/vuln-ledger.jsonl');
  safeMkdir(path.dirname(ledgerPath), { recursive: true });
  const timestamp = new Date().toISOString();
  for (const finding of findings) {
    safeAppendFileSync(
      ledgerPath,
      `${JSON.stringify({
        kind: 'dependency_vulnerability',
        timestamp,
        package_name: finding.packageName,
        severity: finding.severity,
        current_version: finding.currentVersion,
        wanted_version: finding.wantedVersion,
        latest_version: finding.latestVersion,
        reachability: finding.reachability,
        attack_surface: finding.attackSurface,
        semver_jump: finding.semverJump,
        test_gap: finding.testGap,
        rollback_difficulty: finding.rollbackDifficulty,
        decision: finding.decision,
        state: finding.state,
        cve_ids: finding.cveIds,
        advisories: finding.advisories,
        reasons: finding.reasons,
        re_evaluate_when: finding.reEvaluateWhen,
      })}\n`,
      'utf8'
    );
  }
  return ledgerPath;
}

export function scanDependencyVulns(options: DependencyVulnScanOptions = {}): DependencyVulnScanReport {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const directDependencies = collectDirectDependencyNames(rootDir);
  const { audit, outdated } = loadInputs(options);
  const findings = parseAuditFindings(audit, outdated, directDependencies);
  const ledgerPath = options.ledgerPath ?? pathResolver.shared('runtime/vuln-ledger.jsonl');
  const wroteLedger = options.writeLedger !== false && findings.length > 0;
  if (wroteLedger) writeDependencyVulnLedger(findings, { ledgerPath, rootDir });
  return {
    scannedAt: new Date().toISOString(),
    findings,
    ledgerPath,
    wroteLedger,
  };
}

export function formatDependencyVulnScanReport(report: DependencyVulnScanReport): string[] {
  const lines = [
    `Dependency vuln scan: findings=${report.findings.length}; ledger=${report.wroteLedger ? 'written' : 'not-written'}; path=${report.ledgerPath}`,
  ];
  for (const finding of report.findings) {
    lines.push(
      `- ${finding.packageName}: severity=${finding.severity}; reachability=${finding.reachability}; decision=${finding.decision}; state=${finding.state}`
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
    const prefix = `${name}=`;
    const match = args.find((arg) => arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : undefined;
  };
  const hasArg = (name: string): boolean => args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));

  const report = scanDependencyVulns({
    rootDir: getArg('--root-dir'),
    ledgerPath: getArg('--ledger-path'),
    auditJson: getArg('--audit-json'),
    outdatedJson: getArg('--outdated-json'),
    writeLedger: !hasArg('--no-ledger'),
  });

  if (hasArg('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatDependencyVulnScanReport(report)) console.log(line);
  }

  process.exit(report.findings.length > 0 ? 0 : 0);
}

const isDirect = process.argv[1] && /scan_dependency_vulns\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
