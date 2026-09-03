#!/usr/bin/env node
import * as path from 'node:path';
import { GENERATION_QUOTA_COUNTER_REPO_SUBPATH } from '@agent/core/generation-quota';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import { resolveTenant } from '@agent/core/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeLstat,
  safeReadFile,
  safeMoveSync,
  safeRmSync,
  safeStat,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycleBestEffort,
} from '@agent/core/protocol-service-lifecycle';
import { getRegisteredEnvText, isRecord, nowIso, parseSafeJsonInput } from '@agent/core/foundation';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';
import { logger } from '@agent/core/core';

export type BackupScope = 'all' | 'mission' | 'tenant';
type BackupCommand = 'create' | 'restore' | 'list' | 'prune' | 'drill';

export interface BackupCliOptions {
  command: BackupCommand;
  scope: BackupScope;
  out?: string;
  archive?: string;
  mission?: string;
  tenant?: string;
  target?: string;
  backupDir?: string;
  encrypt?: boolean;
  passphraseEnv: string;
  verifyBaseline?: boolean;
  force?: boolean;
  prepareCheckout?: boolean;
  retainDaily: number;
  retainWeekly: number;
  prune?: boolean;
}

export interface BackupPlan {
  scope: BackupScope;
  includesSensitive: boolean;
  entries: string[];
  missionGitRepos: MissionGitRepo[];
  warnings: string[];
}

export interface MissionGitRepo {
  missionPath: string;
  repoRelativePath: string;
}

export interface BackupStatusSummary {
  backupDir: string;
  count: number;
  latestName: string | null;
  latestCreatedAt: string | null;
  latestSizeBytes: number | null;
  latestAgeHours: number | null;
  status: 'missing' | 'fresh' | 'stale';
}

interface PlanOptions {
  scope: BackupScope;
  mission?: string;
  tenant?: string;
  rootDir?: string;
  pathExists?: (repoRelativePath: string) => boolean;
  tenantResolver?: (tenant: string, rootDir: string) => void;
}

const DEFAULT_PASSPHRASE_ENV = 'KYBERION_BACKUP_PASSPHRASE';

function usage(): string {
  return [
    'Usage:',
    '  pnpm backup create [--scope all|mission|tenant] [--mission <id>] [--tenant <slug>] --out <archive.tar.gz.enc> --encrypt',
    '  pnpm backup restore <archive.tar.gz.enc|archive.tar.gz> --target <clean-root> [--scope all|mission|tenant] [--tenant <slug>] [--verify-baseline] [--force]',
    '  pnpm backup list [--dir <backup-dir>]',
    '  pnpm backup prune [--dir <backup-dir>] [--retain-daily 7] [--retain-weekly 4]',
    '  pnpm backup drill [--archive <path>|--dir <backup-dir>] [--scope all|mission|tenant] [--tenant <slug>] [--target <clean-root>] [--prepare-checkout] [--verify-baseline] [--force]',
    '',
    `Sensitive scopes require --encrypt and ${DEFAULT_PASSPHRASE_ENV}.`,
  ].join('\n');
}

function readArgValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

export function parseBackupArgs(argv: string[]): BackupCliOptions {
  const [command, ...rest] = argv;
  if (!['create', 'restore', 'list', 'prune', 'drill'].includes(command || '')) {
    throw new Error(usage());
  }

  const options: BackupCliOptions = {
    command: command as BackupCommand,
    scope: 'all',
    passphraseEnv: DEFAULT_PASSPHRASE_ENV,
    retainDaily: 7,
    retainWeekly: 4,
  };

  if (command === 'restore' && rest[0] && !rest[0].startsWith('--')) {
    options.archive = rest.shift();
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case '--scope': {
        const scope = readArgValue(rest, i, arg) as BackupScope;
        if (!['all', 'mission', 'tenant'].includes(scope)) {
          throw new Error(`Invalid --scope: ${scope}`);
        }
        options.scope = scope;
        i += 1;
        break;
      }
      case '--out':
        options.out = readArgValue(rest, i, arg);
        i += 1;
        break;
      case '--archive':
        options.archive = readArgValue(rest, i, arg);
        i += 1;
        break;
      case '--mission':
        options.mission = readArgValue(rest, i, arg);
        i += 1;
        break;
      case '--tenant':
      case '--customer':
        options.tenant = readArgValue(rest, i, arg);
        i += 1;
        break;
      case '--target':
        options.target = readArgValue(rest, i, arg);
        i += 1;
        break;
      case '--dir':
        options.backupDir = readArgValue(rest, i, arg);
        i += 1;
        break;
      case '--encrypt':
        options.encrypt = true;
        break;
      case '--passphrase-env':
        options.passphraseEnv = readArgValue(rest, i, arg);
        i += 1;
        break;
      case '--verify-baseline':
        options.verifyBaseline = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--prepare-checkout':
        options.prepareCheckout = true;
        break;
      case '--retain-daily':
        options.retainDaily = Number.parseInt(readArgValue(rest, i, arg), 10);
        i += 1;
        break;
      case '--retain-weekly':
        options.retainWeekly = Number.parseInt(readArgValue(rest, i, arg), 10);
        i += 1;
        break;
      case '--prune':
        options.prune = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  return options;
}

function assertRetentionValue(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 365) {
    throw new Error(`${name} must be an integer between 0 and 365`);
  }
}

function normalizeRepoRelative(rootDir: string, target: string): string {
  const rel = path.relative(rootDir, target).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Backup entry is outside the repository root: ${target}`);
  }
  return rel;
}

function addIfExists(
  entries: Set<string>,
  repoRelativePath: string,
  pathExists: (repoRelativePath: string) => boolean
): void {
  if (pathExists(repoRelativePath)) entries.add(repoRelativePath);
}

function addTenantMatches(
  entries: Set<string>,
  rootDir: string,
  tenant: string,
  baseRepoPath: string,
  pathExists: (repoRelativePath: string) => boolean
): void {
  if (!pathExists(baseRepoPath)) return;
  const basePath = path.join(rootDir, baseRepoPath);
  for (const tier of safeReaddir(basePath)) {
    const tierPath = path.join(basePath, tier);
    try {
      if (!safeStat(tierPath).isDirectory()) continue;
    } catch (_) {
      continue;
    }
    const tenantPath = path.join(tierPath, tenant);
    const tenantRepoPath = normalizeRepoRelative(rootDir, tenantPath);
    addIfExists(entries, tenantRepoPath, pathExists);
  }
}

/**
 * Tenant exports must include the physical namespaces introduced for runtime
 * records. Walk only the explicitly registered roots and stop at the
 * `tenants/{slug}` boundary; never infer ownership from arbitrary JSON.
 */
function addPhysicalTenantNamespaceMatches(
  entries: Set<string>,
  rootDir: string,
  tenant: string,
  baseRepoPath: string,
  pathExists: (repoRelativePath: string) => boolean,
  depth = 0
): void {
  if (depth > 6 || !pathExists(baseRepoPath)) return;
  const basePath = path.join(rootDir, baseRepoPath);
  let children: string[];
  try {
    children = safeReaddir(basePath);
  } catch {
    return;
  }
  for (const child of children) {
    if (child === '.quarantine' || child === 'node_modules') continue;
    const childRepoPath = `${baseRepoPath}/${child}`;
    const childPath = path.join(rootDir, childRepoPath);
    let stat;
    try {
      stat = safeLstat(childPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (child === 'tenants') {
      addIfExists(
        entries,
        normalizeRepoRelative(rootDir, path.join(childPath, tenant)),
        pathExists
      );
      continue;
    }
    addPhysicalTenantNamespaceMatches(
      entries,
      rootDir,
      tenant,
      childRepoPath,
      pathExists,
      depth + 1
    );
  }
}

function collectMissionGitRepos(
  rootDir: string,
  repoRelativePath: string,
  results: Map<string, MissionGitRepo>,
  depth = 0
): void {
  if (depth > 5) return;
  const fullPath = path.join(rootDir, repoRelativePath);
  try {
    if (!safeStat(fullPath).isDirectory()) return;
  } catch (_) {
    return;
  }

  if (safeExistsSync(path.join(fullPath, '.git'))) {
    results.set(repoRelativePath, {
      missionPath: fullPath,
      repoRelativePath,
    });
    return;
  }

  for (const entry of safeReaddir(fullPath)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    collectMissionGitRepos(rootDir, `${repoRelativePath}/${entry}`, results, depth + 1);
  }
}

function resolveMissionGitRepos(
  rootDir: string,
  entries: string[],
  pathExists: (repoRelativePath: string) => boolean
): MissionGitRepo[] {
  const repos = new Map<string, MissionGitRepo>();
  for (const entry of entries) {
    if (
      entry.includes('/missions/') ||
      entry === 'active/missions' ||
      entry === 'active/archive/missions' ||
      entry === 'knowledge/personal/missions'
    ) {
      collectMissionGitRepos(rootDir, entry, repos);
    }
  }
  for (const root of [
    'active/missions',
    'active/archive/missions',
    'knowledge/personal/missions',
  ]) {
    if (pathExists(root)) collectMissionGitRepos(rootDir, root, repos);
  }
  return [...repos.values()].sort((a, b) => a.repoRelativePath.localeCompare(b.repoRelativePath));
}

export function resolveBackupPlan(options: PlanOptions): BackupPlan {
  const rootDir = options.rootDir || pathResolver.rootDir();
  const pathExists =
    options.pathExists ||
    ((repoRelativePath: string) => safeExistsSync(path.join(rootDir, repoRelativePath)));
  const entries = new Set<string>();
  const warnings: string[] = [];

  if (options.scope === 'all') {
    for (const repoPath of ['active', 'vault', 'knowledge/personal', 'knowledge/confidential']) {
      addIfExists(entries, repoPath, pathExists);
    }
  } else if (options.scope === 'mission') {
    if (!options.mission) throw new Error('--mission is required for --scope mission');
    const missionPath = pathResolver.findMissionPath(options.mission);
    if (!missionPath) {
      throw new Error(`Mission not found: ${options.mission}`);
    }
    addIfExists(entries, normalizeRepoRelative(rootDir, missionPath), pathExists);
  } else if (options.scope === 'tenant') {
    if (!options.tenant) throw new Error('--tenant/--customer is required for --scope tenant');
    const tenant = options.tenant;
    if (!isValidTenantSlug(tenant)) {
      throw new Error(`Invalid tenant slug: ${tenant}`);
    }
    const tenantResolver =
      options.tenantResolver ||
      ((slug: string, registryRoot: string) => resolveTenant(slug, { rootDir: registryRoot }));
    tenantResolver(tenant, rootDir);
    addTenantMatches(entries, rootDir, tenant, 'active/projects', pathExists);
    addTenantMatches(entries, rootDir, tenant, 'active/missions', pathExists);
    for (const repoPath of [
      // Includes the DA-05 asset ledger (knowledge/confidential/{tenant}/_ledger/)
      // by covering the whole tenant knowledge root.
      `knowledge/confidential/${tenant}`,
      `knowledge/personal/${tenant}`,
      `knowledge/personal/tenants/${tenant}`,
      `knowledge/personal/customers/${tenant}`,
      `customer/${tenant}`,
      `customers/${tenant}`,
      // DA-08: incremental-sync cursor state (DA-03) rides along in the
      // tenant export so an offboarded tenant's sync position is restorable.
      `active/shared/runtime/ingest-cursors/${tenant}`,
      `${GENERATION_QUOTA_COUNTER_REPO_SUBPATH}/${tenant}`,
    ]) {
      addIfExists(entries, repoPath, pathExists);
    }
    for (const physicalRoot of TENANT_PHYSICAL_BACKUP_ROOTS) {
      addPhysicalTenantNamespaceMatches(entries, rootDir, tenant, physicalRoot, pathExists);
    }
  }

  if (entries.size === 0) {
    warnings.push(`No files matched backup scope ${options.scope}.`);
  }

  const sortedEntries = [...entries].sort((a, b) => a.localeCompare(b));
  const includesSensitive =
    options.scope === 'tenant' ||
    sortedEntries.some(
      (entry) =>
        entry === 'vault' ||
        entry.startsWith('vault/') ||
        entry === 'knowledge/confidential' ||
        entry.startsWith('knowledge/confidential/') ||
        entry.startsWith('active/missions/confidential') ||
        entry.startsWith('active/projects/confidential')
    );

  return {
    scope: options.scope,
    includesSensitive,
    entries: sortedEntries,
    missionGitRepos: resolveMissionGitRepos(rootDir, sortedEntries, pathExists),
    warnings,
  };
}

function stamp(): string {
  return nowIso().replace(/[:.]/g, '-');
}

function defaultBackupDir(): string {
  return pathResolver.sharedExports('backups');
}

function defaultOutPath(scope: BackupScope): string {
  return path.join(defaultBackupDir(), `kyberion-${scope}-${stamp()}.tar.gz.enc`);
}

function sameDeviceWarning(targetPath: string): string | null {
  const root = pathResolver.rootDir();
  const targetDir = path.dirname(path.resolve(targetPath));
  const rootDf = safeExecResult('df', ['-P', root], { timeoutMs: 10000 });
  const targetDf = safeExecResult('df', ['-P', targetDir], { timeoutMs: 10000 });
  if (rootDf.status !== 0 || targetDf.status !== 0) return null;
  const rootDevice = rootDf.stdout.trim().split('\n').at(-1)?.split(/\s+/)[0];
  const targetDevice = targetDf.stdout.trim().split('\n').at(-1)?.split(/\s+/)[0];
  if (rootDevice && targetDevice && rootDevice === targetDevice) {
    return `Backup target appears to be on the same device as the source (${rootDevice}); this is not disaster recovery.`;
  }
  return null;
}

function requirePassphrase(envName: string): string {
  const passphrase = process.env[envName];
  if (!passphrase) {
    throw new Error(
      `Missing ${envName}; encrypted backups require a passphrase in that environment variable.`
    );
  }
  return passphrase;
}

function runRequired(
  command: string,
  args: string[],
  errorPrefix: string,
  env: Record<string, string> = {}
): void {
  const result = safeExecResult(command, args, {
    timeoutMs: 120000,
    maxOutputMB: 50,
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${errorPrefix}: ${result.stderr || result.stdout || result.error?.message || 'command failed'}`
    );
  }
}

function installCleanCheckoutDependencies(target: string): void {
  const strict = safeExecResult('pnpm', ['install', '--frozen-lockfile', '--offline'], {
    cwd: target,
    timeoutMs: 600000,
    maxOutputMB: 50,
  });
  if (strict.status === 0) return;

  const fallback = safeExecResult('pnpm', ['install', '--offline', '--no-frozen-lockfile'], {
    cwd: target,
    timeoutMs: 600000,
    maxOutputMB: 50,
  });
  if (fallback.status === 0) return;

  const sourceNodeModules = path.join(pathResolver.rootDir(), 'node_modules');
  const targetNodeModules = path.join(target, 'node_modules');
  if (safeExistsSync(sourceNodeModules) && !safeExistsSync(targetNodeModules)) {
    safeSymlinkSync(sourceNodeModules, targetNodeModules, 'dir');
    return;
  }

  throw new Error(
    `clean checkout dependency install failed: strict=${strict.stderr || strict.stdout || strict.error?.message || 'failed'} fallback=${fallback.stderr || fallback.stdout || fallback.error?.message || 'failed'}`
  );
}

function buildCleanCheckout(target: string): void {
  const build = safeExecResult('pnpm', ['build'], {
    cwd: target,
    timeoutMs: 600000,
    maxOutputMB: 50,
  });
  if (build.status === 0) return;

  const sourceDist = path.join(pathResolver.rootDir(), 'dist');
  const targetDist = path.join(target, 'dist');
  const targetPipelineRunner = path.join(targetDist, 'scripts/run_pipeline.js');
  if (safeExistsSync(sourceDist) && !safeExistsSync(targetPipelineRunner)) {
    if (safeExistsSync(targetDist)) {
      safeRmSync(targetDist, { recursive: true, force: true });
    }
    safeSymlinkSync(sourceDist, targetDist, 'dir');
    return;
  }

  throw new Error(
    `clean checkout build failed: ${build.stderr || build.stdout || build.error?.message || 'failed'}`
  );
}

function tarExcludesFor(outPath: string): string[] {
  const excludes = ['active/shared/exports/backups'];
  const rootDir = pathResolver.rootDir();
  const outputRel = path.relative(rootDir, outPath).split(path.sep).join('/');
  if (outputRel && !outputRel.startsWith('..') && !path.isAbsolute(outputRel)) {
    excludes.push(outputRel);
  }
  return [...new Set(excludes)].flatMap((entry) => ['--exclude', entry]);
}

function missionGitExcludes(repos: MissionGitRepo[]): string[] {
  return repos.flatMap((repo) => ['--exclude', `${repo.repoRelativePath}/.git`]);
}

function createMissionGitBundles(tempDir: string, repos: MissionGitRepo[]): string[] {
  if (repos.length === 0) return [];
  const bundleDir = path.join(tempDir, 'mission-git-bundles');
  safeMkdir(bundleDir);
  const bundleRepoPaths: string[] = [];
  for (const repo of repos) {
    const bundleName = `${repo.repoRelativePath.replace(/[\\/]+/g, '__')}.bundle`;
    const bundlePath = path.join(bundleDir, bundleName);
    runRequired(
      'git',
      ['-C', repo.missionPath, 'bundle', 'create', bundlePath, '--all'],
      `git bundle creation failed for ${repo.repoRelativePath}`
    );
    bundleRepoPaths.push(normalizeRepoRelative(pathResolver.rootDir(), bundlePath));
  }
  return bundleRepoPaths.sort((a, b) => a.localeCompare(b));
}

interface BackupFileEntry {
  name: string;
  path: string;
  mtimeMs: number;
}

function backupFileEntries(dir = defaultBackupDir()): BackupFileEntry[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => entry.endsWith('.tar.gz') || entry.endsWith('.tar.gz.enc'))
    .map((entry) => {
      const fullPath = path.join(dir, entry);
      return {
        name: entry,
        path: fullPath,
        mtimeMs: safeStat(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function weekKey(date: Date): string {
  const firstDay = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const dayOffset = Math.floor((date.getTime() - firstDay.getTime()) / 86400000);
  const week = Math.floor((dayOffset + firstDay.getUTCDay()) / 7) + 1;
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function pruneBackups(
  dir = defaultBackupDir(),
  options: { retainDaily?: number; retainWeekly?: number } = {}
): { kept: string[]; deleted: string[] } {
  const retainDaily = options.retainDaily ?? 7;
  const retainWeekly = options.retainWeekly ?? 4;
  assertRetentionValue(retainDaily, '--retain-daily');
  assertRetentionValue(retainWeekly, '--retain-weekly');

  const entries = backupFileEntries(dir);
  const keep = new Set<string>();
  for (const entry of entries.slice(0, retainDaily)) keep.add(entry.path);

  const weeklySeen = new Set<string>();
  for (const entry of entries) {
    if (weeklySeen.size >= retainWeekly) break;
    const key = weekKey(new Date(entry.mtimeMs));
    if (weeklySeen.has(key)) continue;
    weeklySeen.add(key);
    keep.add(entry.path);
  }

  const deleted: string[] = [];
  for (const entry of entries) {
    if (keep.has(entry.path)) continue;
    safeRmSync(entry.path, { force: true });
    deleted.push(entry.name);
  }

  return {
    kept: entries.filter((entry) => keep.has(entry.path)).map((entry) => entry.name),
    deleted,
  };
}

export function createBackup(options: BackupCliOptions): {
  archive: string;
  plan: BackupPlan;
  warnings: string[];
} {
  const plan = resolveBackupPlan({
    scope: options.scope,
    mission: options.mission,
    tenant: options.tenant,
  });
  const outPath = path.resolve(options.out || defaultOutPath(options.scope));
  const warnings = [...plan.warnings];
  const sameDevice = sameDeviceWarning(outPath);
  if (sameDevice) warnings.push(sameDevice);

  if (plan.includesSensitive && !options.encrypt) {
    throw new Error('This backup includes confidential/vault data; rerun with --encrypt.');
  }

  safeMkdir(path.dirname(outPath));
  const tempDir = pathResolver.sharedTmp(`backup-${stamp()}`);
  safeMkdir(tempDir);
  const manifestPath = path.join(tempDir, 'manifest.json');
  const includeListPath = path.join(tempDir, 'include.txt');
  const plainArchivePath = options.encrypt ? path.join(tempDir, 'payload.tar.gz') : outPath;
  const archivePath = options.encrypt && !outPath.endsWith('.enc') ? `${outPath}.enc` : outPath;
  const missionGitBundles = createMissionGitBundles(tempDir, plan.missionGitRepos);

  const manifest = {
    format: 'kyberion-backup-v1',
    created_at: nowIso(),
    scope: plan.scope,
    mission: options.mission || null,
    tenant: options.tenant || null,
    encrypted: Boolean(options.encrypt),
    includes_sensitive: plan.includesSensitive,
    entries: plan.entries,
    mission_git_repos: plan.missionGitRepos.map((repo, index) => ({
      repo_relative_path: repo.repoRelativePath,
      bundle_path: missionGitBundles[index] || null,
    })),
    warnings,
  };
  const manifestRepoPath = normalizeRepoRelative(pathResolver.rootDir(), manifestPath);
  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  safeWriteFile(
    includeListPath,
    [...plan.entries, ...missionGitBundles, manifestRepoPath].join('\n') + '\n'
  );

  runRequired(
    'tar',
    [
      ...tarExcludesFor(archivePath),
      ...missionGitExcludes(plan.missionGitRepos),
      '-czf',
      plainArchivePath,
      '-C',
      pathResolver.rootDir(),
      '-T',
      includeListPath,
    ],
    'backup archive creation failed'
  );

  if (options.encrypt) {
    requirePassphrase(options.passphraseEnv);
    runRequired(
      'openssl',
      [
        'enc',
        '-aes-256-cbc',
        '-pbkdf2',
        '-salt',
        '-in',
        plainArchivePath,
        '-out',
        archivePath,
        '-pass',
        `env:${options.passphraseEnv}`,
      ],
      'backup encryption failed',
      { [options.passphraseEnv]: process.env[options.passphraseEnv] || '' }
    );
    safeRmSync(plainArchivePath, { force: true });
  }

  if (options.prune || options.out === undefined) {
    pruneBackups(path.dirname(archivePath), {
      retainDaily: options.retainDaily,
      retainWeekly: options.retainWeekly,
    });
  }

  return { archive: archivePath, plan, warnings };
}

interface RestoredBackupManifest {
  format?: string;
  scope?: BackupScope;
  tenant?: string | null;
  entries?: string[];
  mission_git_repos?: Array<{
    repo_relative_path?: string;
    bundle_path?: string | null;
  }>;
}

export function parseRestoredBackupManifest(raw: string): RestoredBackupManifest {
  let parsed: unknown;
  try {
    parsed = parseSafeJsonInput(raw, 'Backup manifest');
  } catch (error) {
    throw new Error(
      `Backup manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) throw new Error('Backup manifest root must be a JSON object.');
  if (parsed.format !== 'kyberion-backup-v1') {
    throw new Error('Unsupported or missing backup manifest format.');
  }
  if (parsed.scope !== 'all' && parsed.scope !== 'mission' && parsed.scope !== 'tenant') {
    throw new Error('Backup manifest has an invalid scope.');
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.some((entry) => typeof entry !== 'string')) {
    throw new Error('Backup manifest entries are missing or invalid.');
  }
  if (parsed.tenant !== undefined && parsed.tenant !== null && typeof parsed.tenant !== 'string') {
    throw new Error('Backup manifest tenant is invalid.');
  }
  let missionGitRepos: RestoredBackupManifest['mission_git_repos'];
  if (parsed.mission_git_repos !== undefined) {
    if (!Array.isArray(parsed.mission_git_repos)) {
      throw new Error('Backup manifest mission git metadata is invalid.');
    }
    missionGitRepos = [];
    for (const entry of parsed.mission_git_repos) {
      if (!isRecord(entry) || typeof entry.repo_relative_path !== 'string') {
        throw new Error('Backup manifest mission repository path is invalid.');
      }
      if (
        entry.bundle_path !== undefined &&
        entry.bundle_path !== null &&
        typeof entry.bundle_path !== 'string'
      ) {
        throw new Error('Backup manifest mission bundle path is invalid.');
      }
      missionGitRepos.push({
        repo_relative_path: entry.repo_relative_path,
        ...(entry.bundle_path !== undefined
          ? { bundle_path: entry.bundle_path as string | null }
          : {}),
      });
    }
  }
  return {
    format: parsed.format,
    scope: parsed.scope,
    ...(parsed.tenant !== undefined ? { tenant: parsed.tenant as string | null } : {}),
    entries: parsed.entries,
    ...(missionGitRepos ? { mission_git_repos: missionGitRepos } : {}),
  };
}

const TENANT_PHYSICAL_BACKUP_ROOTS = [
  'active/shared/coordination/channels',
  'active/shared/runtime/presence',
  'active/shared/runtime/media-generation/schedules',
  'active/shared/runtime/media-generation/artifacts',
  'active/shared/runtime/media-generation/cost-settlements',
  'active/shared/runtime/peer-messaging',
  'active/shared/observability/peer-messaging',
  'active/shared/runtime/peer-conversations',
  'active/shared/observability/peer-conversations',
  'active/shared/runtime/mesh-hub',
  'active/shared/observability/mesh-hub',
  'active/shared/runtime/feedback-loop',
  'active/shared/runtime/tenants',
  'active/shared/observability/tenants',
  'active/shared/coordination/tenants',
] as const;

function normalizeArchiveMember(member: string): string {
  const normalized = member.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Backup archive contains an unsafe member path: ${member}`);
  }
  return normalized;
}

function archiveMembers(plainArchive: string): string[] {
  const result = safeExecResult('tar', ['-tzf', plainArchive], {
    timeoutMs: 120000,
    maxOutputMB: 50,
  });
  if (result.status !== 0) {
    throw new Error(
      `backup archive listing failed: ${result.stderr || result.stdout || result.error?.message || 'command failed'}`
    );
  }
  return result.stdout
    .split('\n')
    .map((member) => member.trim())
    .filter(Boolean)
    .map(normalizeArchiveMember);
}

function readArchiveManifest(
  plainArchive: string,
  members: string[]
): { manifest: RestoredBackupManifest; member: string } {
  const manifestMembers = members.filter((member) =>
    /^active\/shared\/tmp\/backup-[^/]+\/manifest\.json$/.test(member)
  );
  if (manifestMembers.length !== 1) {
    throw new Error(
      `Backup archive must contain exactly one backup manifest (found ${manifestMembers.length}).`
    );
  }
  const member = manifestMembers[0];
  const result = safeExecResult('tar', ['-xOzf', plainArchive, member], {
    timeoutMs: 120000,
    maxOutputMB: 10,
  });
  if (result.status !== 0) {
    throw new Error(
      `backup manifest read failed: ${result.stderr || result.stdout || result.error?.message || 'command failed'}`
    );
  }
  const manifest = parseRestoredBackupManifest(result.stdout);
  for (const entry of manifest.entries) normalizeArchiveMember(entry);
  return { manifest, member };
}

function isWithinArchiveRoot(member: string, root: string): boolean {
  return member === root || member.startsWith(`${root}/`) || root.startsWith(`${member}/`);
}

function isArchiveEntryWithinRoot(entry: string, root: string): boolean {
  return entry === root || entry.startsWith(`${root}/`);
}

function isTenantBackupEntry(entry: string, tenant: string): boolean {
  const exactRoots = [
    `knowledge/confidential/${tenant}`,
    `knowledge/personal/${tenant}`,
    `knowledge/personal/tenants/${tenant}`,
    `knowledge/personal/customers/${tenant}`,
    `customer/${tenant}`,
    `customers/${tenant}`,
    `active/shared/runtime/ingest-cursors/${tenant}`,
    `${GENERATION_QUOTA_COUNTER_REPO_SUBPATH}/${tenant}`,
  ];
  if (exactRoots.some((root) => isArchiveEntryWithinRoot(entry, root))) return true;
  if (/^active\/(projects|missions)\/[^/]+\//.test(entry)) {
    const parts = entry.split('/');
    return parts[3] === tenant;
  }
  for (const root of ['active/shared/runtime/mesh-hub', 'active/shared/observability/mesh-hub']) {
    const relative = entry.startsWith(`${root}/`) ? entry.slice(root.length + 1).split('/') : [];
    if (
      (relative[0] === 'tenants' && relative[1] === tenant) ||
      (relative[1] === 'tenants' && relative[2] === tenant)
    ) {
      return true;
    }
  }
  return TENANT_PHYSICAL_BACKUP_ROOTS.some((root) =>
    isArchiveEntryWithinRoot(entry, `${root}/tenants/${tenant}`)
  );
}

function validateArchiveManifestScope(
  manifest: RestoredBackupManifest,
  manifestMember: string,
  members: string[],
  options: BackupCliOptions
): void {
  const scope = manifest.scope as BackupScope;
  const entries = manifest.entries as string[];
  if (manifest.mission_git_repos !== undefined && !Array.isArray(manifest.mission_git_repos)) {
    throw new Error('Backup manifest mission git metadata is invalid.');
  }
  const bundlePaths: string[] = [];
  const manifestDir = manifestMember.slice(0, manifestMember.lastIndexOf('/'));
  for (const entry of manifest.mission_git_repos || []) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Backup manifest mission git metadata is invalid.');
    }
    if (typeof entry.repo_relative_path !== 'string') {
      throw new Error('Backup manifest mission repository path is invalid.');
    }
    const repoRelativePath = normalizeArchiveMember(entry.repo_relative_path);
    if (
      scope === 'tenant' &&
      (typeof manifest.tenant !== 'string' ||
        !isTenantBackupEntry(repoRelativePath, manifest.tenant))
    ) {
      throw new Error(
        'Tenant backup manifest contains a mission repository outside the tenant scope.'
      );
    }
    if (entry.bundle_path !== null && entry.bundle_path !== undefined) {
      if (typeof entry.bundle_path !== 'string') {
        throw new Error('Backup manifest mission bundle path is invalid.');
      }
      const bundlePath = normalizeArchiveMember(entry.bundle_path);
      if (!bundlePath.startsWith(`${manifestDir}/mission-git-bundles/`)) {
        throw new Error('Backup manifest mission bundle is outside the backup temp namespace.');
      }
      bundlePaths.push(bundlePath);
    }
  }
  const allowedRoots = [...entries, manifestMember, ...bundlePaths];

  if (scope === 'tenant') {
    if (typeof manifest.tenant !== 'string' || !isValidTenantSlug(manifest.tenant)) {
      throw new Error('Tenant backup manifest has an invalid tenant slug.');
    }
    if (options.scope !== 'tenant' || !options.tenant) {
      throw new Error(
        'Tenant backup restore requires --scope tenant --tenant <slug> so the restore boundary is explicit.'
      );
    }
    if (options.tenant !== manifest.tenant) {
      throw new Error(
        `Tenant backup restore scope mismatch: archive=${manifest.tenant}, requested=${options.tenant}`
      );
    }
    if (!entries.every((entry) => isTenantBackupEntry(entry, manifest.tenant))) {
      throw new Error(
        'Tenant backup manifest contains an entry outside the tenant export allowlist.'
      );
    }
  } else if (options.scope !== 'all' && options.scope !== scope) {
    throw new Error(`Backup restore scope mismatch: archive=${scope}, requested=${options.scope}`);
  }

  for (const member of members) {
    if (!allowedRoots.some((root) => isWithinArchiveRoot(member, root))) {
      throw new Error(`Backup archive member is outside the manifest scope: ${member}`);
    }
  }
}

function validateBackupArchive(plainArchive: string, options: BackupCliOptions): void {
  const members = archiveMembers(plainArchive);
  const { manifest, member } = readArchiveManifest(plainArchive, members);
  validateArchiveManifestScope(manifest, member, members, options);
}

function findRestoredManifests(target: string): string[] {
  const tmpDir = path.join(target, 'active/shared/tmp');
  if (!safeExistsSync(tmpDir)) return [];
  const manifests: string[] = [];
  for (const entry of safeReaddir(tmpDir)) {
    const manifestPath = path.join(tmpDir, entry, 'manifest.json');
    if (
      entry.startsWith('backup-') &&
      safeExistsSync(manifestPath) &&
      safeLstat(manifestPath).isFile()
    ) {
      manifests.push(manifestPath);
    }
  }
  return manifests.sort((a, b) => b.localeCompare(a));
}

function restoreMissionGitBundles(target: string): void {
  const [manifestPath] = findRestoredManifests(target);
  if (!manifestPath) return;
  const manifest = parseRestoredBackupManifest(
    String(safeReadFile(manifestPath, { encoding: 'utf8' }))
  );
  if (manifest.format !== 'kyberion-backup-v1') return;

  for (const entry of manifest.mission_git_repos || []) {
    if (!entry.repo_relative_path || !entry.bundle_path) continue;
    const repoPath = path.join(target, entry.repo_relative_path);
    const bundlePath = path.join(target, entry.bundle_path);
    if (!safeExistsSync(repoPath) || !safeExistsSync(bundlePath)) continue;
    if (safeExistsSync(path.join(repoPath, '.git'))) continue;
    runRequired('git', ['-C', repoPath, 'init'], `git init failed for ${entry.repo_relative_path}`);
    runRequired(
      'git',
      ['-C', repoPath, 'fetch', bundlePath, 'refs/heads/*:refs/heads/*'],
      `git bundle fetch failed for ${entry.repo_relative_path}`
    );
    const branches = safeExecResult('git', ['-C', repoPath, 'branch', '--format=%(refname:short)']);
    const branchList = branches.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const branch = branchList.includes('main') ? 'main' : branchList[0];
    if (branch) {
      safeExecResult('git', ['-C', repoPath, 'checkout', '-f', branch]);
    }
  }
}

/**
 * A tenant restore must never make a stale peer lease, presence record, or
 * proposal executable immediately. Move all restored peer/Mesh runtime state
 * out of the live roots; re-enrollment and a fresh heartbeat are the resume
 * gate. The quarantine is deliberately inside the restored tree so the
 * operation remains self-contained and auditable.
 */
function quarantineRestoredPeerRuntime(
  target: string,
  tenant: string
): { quarantinePath: string; moved: string[] } {
  const stampId = stamp();
  const moved: string[] = [];
  const quarantineRoot = path.join(
    target,
    'active/shared/runtime/peer-recovery-quarantine/tenants',
    tenant,
    stampId
  );
  const candidates: Array<{ source: string; label: string }> = [
    {
      source: path.join(target, 'active/shared/runtime/peer-messaging/tenants', tenant),
      label: 'runtime-peer-messaging',
    },
    {
      source: path.join(target, 'active/shared/observability/peer-messaging/tenants', tenant),
      label: 'observability-peer-messaging',
    },
    {
      source: path.join(target, 'active/shared/runtime/peer-conversations/tenants', tenant),
      label: 'runtime-peer-conversations',
    },
    {
      source: path.join(target, 'active/shared/observability/peer-conversations/tenants', tenant),
      label: 'observability-peer-conversations',
    },
  ];

  for (const base of [
    ['active/shared/runtime/mesh-hub', 'runtime-mesh-hub'],
    ['active/shared/observability/mesh-hub', 'observability-mesh-hub'],
  ] as const) {
    const root = path.join(target, base[0]);
    if (!safeExistsSync(root)) continue;
    for (const entry of safeReaddir(root)) {
      const namespaceRoot = path.join(root, entry);
      const tenantRoot = path.join(namespaceRoot, 'tenants', tenant);
      if (entry === 'tenants' && safeExistsSync(path.join(root, 'tenants', tenant))) {
        candidates.push({ source: path.join(root, 'tenants', tenant), label: base[1] });
      } else if (safeExistsSync(tenantRoot)) {
        candidates.push({
          source: tenantRoot,
          label: `${base[1]}-${entry.replace(/[^a-zA-Z0-9._-]+/g, '-')}`,
        });
      }
    }
  }

  for (const candidate of candidates) {
    if (!safeExistsSync(candidate.source)) continue;
    const destination = path.join(quarantineRoot, candidate.label);
    safeMkdir(path.dirname(destination));
    safeMoveSync(candidate.source, destination);
    moved.push(path.relative(target, destination));
  }

  if (moved.length > 0) {
    safeMkdir(quarantineRoot);
    safeWriteFile(
      path.join(quarantineRoot, 'quarantine-manifest.json'),
      `${JSON.stringify(
        {
          format: 'kyberion-peer-runtime-quarantine-v1',
          tenant,
          created_at: nowIso(),
          reason: 'tenant_restore_requires_reenrollment_and_fresh_heartbeat',
          moved,
        },
        null,
        2
      )}\n`
    );
  }
  return { quarantinePath: quarantineRoot, moved };
}

export function restoreBackup(options: BackupCliOptions): {
  target: string;
  archive: string;
  quarantinePaths: string[];
} {
  if (!options.archive) throw new Error('restore requires an archive path');
  const archive = path.resolve(options.archive);
  if (!safeExistsSync(archive)) throw new Error(`Archive not found: ${archive}`);
  if (!options.target) throw new Error('restore requires --target <clean-root>');
  const target = path.resolve(options.target);
  if (safeExistsSync(target) && safeReaddir(target).length > 0 && !options.force) {
    throw new Error(`Restore target is not empty; pass --force to restore into ${target}`);
  }

  const tempDir = pathResolver.sharedTmp(`restore-${stamp()}`);
  safeMkdir(tempDir);
  const plainArchive = archive.endsWith('.enc') ? path.join(tempDir, 'payload.tar.gz') : archive;
  if (archive.endsWith('.enc')) {
    requirePassphrase(options.passphraseEnv);
    runRequired(
      'openssl',
      [
        'enc',
        '-d',
        '-aes-256-cbc',
        '-pbkdf2',
        '-in',
        archive,
        '-out',
        plainArchive,
        '-pass',
        `env:${options.passphraseEnv}`,
      ],
      'backup decryption failed',
      { [options.passphraseEnv]: process.env[options.passphraseEnv] || '' }
    );
  }

  validateBackupArchive(plainArchive, options);
  safeMkdir(target);
  runRequired('tar', ['-xzf', plainArchive, '-C', target], 'backup restore extraction failed');
  const quarantinePaths: string[] = [];
  if (options.scope === 'tenant' && options.tenant) {
    const quarantine = quarantineRestoredPeerRuntime(target, options.tenant);
    if (quarantine.moved.length > 0) quarantinePaths.push(quarantine.quarantinePath);
  }
  restoreMissionGitBundles(target);

  if (options.verifyBaseline) {
    const result = safeExecResult(
      'pnpm',
      ['pipeline', '--input', 'pipelines/baseline-check.json'],
      { cwd: target, timeoutMs: 120000, maxOutputMB: 20 }
    );
    if (result.status !== 0) {
      throw new Error(`baseline-check failed after restore: ${result.stderr || result.stdout}`);
    }
  }

  return { target, archive, quarantinePaths };
}

export function runRestoreDrill(options: BackupCliOptions): {
  archive: string;
  target: string;
  checkoutPrepared: boolean;
  baselineVerified: boolean;
  restoredManifestCount: number;
  quarantinePaths: string[];
} {
  const archive =
    options.archive ||
    backupFileEntries(options.backupDir)
      .map((entry) => entry.path)
      .at(0);
  if (!archive) {
    throw new Error(
      `No backup archive found for restore drill${options.backupDir ? ` in ${options.backupDir}` : ''}`
    );
  }
  const target = path.resolve(
    options.target || pathResolver.sharedTmp(`backup-restore-drill-${stamp()}`)
  );
  if (options.force && safeExistsSync(target)) {
    safeRmSync(target, { recursive: true, force: true });
  }
  if (options.prepareCheckout) {
    safeMkdir(path.dirname(target));
    runRequired(
      'git',
      ['clone', '--local', '--no-hardlinks', pathResolver.rootDir(), target],
      'clean checkout preparation failed'
    );
    if (options.verifyBaseline) {
      installCleanCheckoutDependencies(target);
      buildCleanCheckout(target);
    }
  }
  const result = restoreBackup({
    ...options,
    archive,
    target,
    force: options.force ?? true,
  });
  return {
    archive: result.archive,
    target: result.target,
    checkoutPrepared: Boolean(options.prepareCheckout),
    baselineVerified: Boolean(options.verifyBaseline),
    restoredManifestCount: findRestoredManifests(result.target).length,
    quarantinePaths: result.quarantinePaths,
  };
}

export function listBackups(dir = defaultBackupDir()): string[] {
  return backupFileEntries(dir).map((entry) => entry.name);
}

export function summarizeBackupStatus(
  dir = defaultBackupDir(),
  options: { staleAfterHours?: number; now?: Date } = {}
): BackupStatusSummary {
  const entries = backupFileEntries(dir);
  const latest = entries[0];
  if (!latest) {
    return {
      backupDir: dir,
      count: 0,
      latestName: null,
      latestCreatedAt: null,
      latestSizeBytes: null,
      latestAgeHours: null,
      status: 'missing',
    };
  }
  const now = options.now ?? new Date();
  const latestAgeHours = Math.max(0, (now.getTime() - latest.mtimeMs) / 3600000);
  const staleAfterHours = options.staleAfterHours ?? 36;
  return {
    backupDir: dir,
    count: entries.length,
    latestName: latest.name,
    latestCreatedAt: new Date(latest.mtimeMs).toISOString(),
    latestSizeBytes: safeStat(latest.path).size,
    latestAgeHours,
    status: latestAgeHours > staleAfterHours ? 'stale' : 'fresh',
  };
}

export function main(argv: string[], print: (value: unknown) => void = () => undefined): void {
  assertProtocolServiceRegistered('backup-restore');
  const options = parseBackupArgs(argv);
  if (options.command === 'create') {
    const result = createBackup(options);
    for (const warning of result.warnings) logger.warn(`[backup] warning: ${warning}`);
    print({ ok: true, archive: result.archive, entries: result.plan.entries });
    return;
  }
  if (options.command === 'restore') {
    const result = restoreBackup(options);
    const scope =
      options.scope === 'tenant' && options.tenant
        ? {
            scope_kind: 'tenant' as const,
            tier: 'confidential' as const,
            tenant_slug: options.tenant,
          }
        : { scope_kind: 'system' as const, tier: 'public' as const };
    const lifecycleReceipt = recordProtocolServiceLifecycleBestEffort({
      serviceId: 'backup-restore',
      action: 'restore',
      status: 'restored',
      scope,
      actorRole: 'infrastructure_sentinel',
      principal: { kind: 'service', id: 'backup-restore' },
      requestedBy: getRegisteredEnvText('KYBERION_PERSONA') || 'backup-operator',
      metadata: {
        archive: portableProtocolServicePathRef(result.archive),
        target: portableProtocolServicePathRef(result.target),
      },
    });
    if (!lifecycleReceipt) logger.warn('[backup] restore lifecycle receipt unavailable');
    if (result.quarantinePaths.length > 0) {
      const quarantineReceipt = recordProtocolServiceLifecycleBestEffort({
        serviceId: 'backup-restore',
        action: 'restore_quarantine',
        status: 'quarantined',
        scope,
        actorRole: 'infrastructure_sentinel',
        principal: { kind: 'service', id: 'backup-restore' },
        requestedBy: getRegisteredEnvText('KYBERION_PERSONA') || 'backup-operator',
        metadata: { quarantine_count: result.quarantinePaths.length },
      });
      if (!quarantineReceipt) logger.warn('[backup] quarantine lifecycle receipt unavailable');
    }
    print({
      ok: true,
      archive: result.archive,
      target: result.target,
      quarantine_paths: result.quarantinePaths,
    });
    return;
  }
  if (options.command === 'prune') {
    const result = pruneBackups(options.backupDir, {
      retainDaily: options.retainDaily,
      retainWeekly: options.retainWeekly,
    });
    print({ ok: true, ...result });
    return;
  }
  if (options.command === 'drill') {
    const result = runRestoreDrill(options);
    print({ ok: true, ...result });
    return;
  }
  const backups = listBackups(options.backupDir);
  print({ ok: true, backups });
}

if (isDirectScript(import.meta.url, 'backup.ts') || isDirectScript(import.meta.url, 'backup.js'))
  void defineScript({
    name: 'backup',
    flags: ['json', 'quiet'],
    run: ({ argv, print }) => main(stripSharedScriptFlags(argv), print),
  })();
