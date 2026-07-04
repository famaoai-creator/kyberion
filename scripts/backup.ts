#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pathResolver,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeStat,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core';

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
}

const DEFAULT_PASSPHRASE_ENV = 'KYBERION_BACKUP_PASSPHRASE';

function usage(): string {
  return [
    'Usage:',
    '  pnpm backup create [--scope all|mission|tenant] [--mission <id>] [--tenant <slug>] --out <archive.tar.gz.enc> --encrypt',
    '  pnpm backup restore <archive.tar.gz.enc|archive.tar.gz> --target <clean-root> [--verify-baseline] [--force]',
    '  pnpm backup list [--dir <backup-dir>]',
    '  pnpm backup prune [--dir <backup-dir>] [--retain-daily 7] [--retain-weekly 4]',
    '  pnpm backup drill [--archive <path>|--dir <backup-dir>] [--target <clean-root>] [--prepare-checkout] [--verify-baseline] [--force]',
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
    addTenantMatches(entries, rootDir, tenant, 'active/projects', pathExists);
    addTenantMatches(entries, rootDir, tenant, 'active/missions', pathExists);
    for (const repoPath of [
      `knowledge/confidential/${tenant}`,
      `knowledge/personal/${tenant}`,
      `knowledge/personal/customers/${tenant}`,
      `customer/${tenant}`,
      `customers/${tenant}`,
    ]) {
      addIfExists(entries, repoPath, pathExists);
    }
  }

  if (entries.size === 0) {
    warnings.push(`No files matched backup scope ${options.scope}.`);
  }

  const sortedEntries = [...entries].sort((a, b) => a.localeCompare(b));
  const includesSensitive = sortedEntries.some(
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
  return new Date().toISOString().replace(/[:.]/g, '-');
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

function runRequiredIn(
  cwd: string,
  command: string,
  args: string[],
  errorPrefix: string,
  timeoutMs = 120000
): void {
  const result = safeExecResult(command, args, {
    cwd,
    timeoutMs,
    maxOutputMB: 50,
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
    created_at: new Date().toISOString(),
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
  mission_git_repos?: Array<{
    repo_relative_path?: string;
    bundle_path?: string | null;
  }>;
}

function findRestoredManifests(target: string): string[] {
  const tmpDir = path.join(target, 'active/shared/tmp');
  if (!safeExistsSync(tmpDir)) return [];
  const manifests: string[] = [];
  for (const entry of safeReaddir(tmpDir)) {
    const manifestPath = path.join(tmpDir, entry, 'manifest.json');
    if (entry.startsWith('backup-') && safeExistsSync(manifestPath)) {
      manifests.push(manifestPath);
    }
  }
  return manifests.sort((a, b) => b.localeCompare(a));
}

function restoreMissionGitBundles(target: string): void {
  const [manifestPath] = findRestoredManifests(target);
  if (!manifestPath) return;
  const manifest = JSON.parse(
    safeReadFile(manifestPath, { encoding: 'utf8' }) as string
  ) as RestoredBackupManifest;
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

export function restoreBackup(options: BackupCliOptions): { target: string; archive: string } {
  const archive = path.resolve(options.archive || '');
  if (!archive) throw new Error('restore requires an archive path');
  if (!safeExistsSync(archive)) throw new Error(`Archive not found: ${archive}`);
  const target = path.resolve(options.target || '');
  if (!target) throw new Error('restore requires --target <clean-root>');
  if (safeExistsSync(target) && safeReaddir(target).length > 0 && !options.force) {
    throw new Error(`Restore target is not empty; pass --force to restore into ${target}`);
  }
  safeMkdir(target);

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

  runRequired('tar', ['-xzf', plainArchive, '-C', target], 'backup restore extraction failed');
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

  return { target, archive };
}

export function runRestoreDrill(options: BackupCliOptions): {
  archive: string;
  target: string;
  checkoutPrepared: boolean;
  baselineVerified: boolean;
  restoredManifestCount: number;
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

export function main(argv = process.argv.slice(2)): void {
  const options = parseBackupArgs(argv);
  if (options.command === 'create') {
    const result = createBackup(options);
    for (const warning of result.warnings) console.warn(`[backup] warning: ${warning}`);
    console.log(
      JSON.stringify({ ok: true, archive: result.archive, entries: result.plan.entries }, null, 2)
    );
    return;
  }
  if (options.command === 'restore') {
    const result = restoreBackup(options);
    console.log(
      JSON.stringify({ ok: true, archive: result.archive, target: result.target }, null, 2)
    );
    return;
  }
  if (options.command === 'prune') {
    const result = pruneBackups(options.backupDir, {
      retainDaily: options.retainDaily,
      retainWeekly: options.retainWeekly,
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  if (options.command === 'drill') {
    const result = runRestoreDrill(options);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  const backups = listBackups(options.backupDir);
  console.log(JSON.stringify({ ok: true, backups }, null, 2));
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    main();
  } catch (err: any) {
    const message = err?.message || String(err);
    if (message.includes('Usage:')) console.error(message);
    else console.error(`[backup] ${message}`);
    process.exit(1);
  }
}
