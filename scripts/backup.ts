#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { GENERATION_QUOTA_COUNTER_REPO_SUBPATH } from '@agent/core/generation-quota';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeCopyFileSync,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeLstat,
  safeMoveSync,
  safeRmSync,
  safeStat,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import {
  tenantRuntimePartitionOf,
  tenantRuntimePartitionPaths,
  type TenantRuntimePartitionPath,
} from '@agent/core/storage-layout';
import {
  assertDrillTargetConfined,
  assertNoAppendOnlyConflict,
  assertTenantLedgerPartitionsIntact,
  currentAuditChainKeyId,
  archiveMembers,
  extractWithStagedPartitions,
  withPlaintextTempDir,
  normalizeArchiveMember,
  type RestoredLedgerVerification,
} from './lib/backup-tenant-partitions.js';
import {
  portableProtocolServicePathRef,
  recordProtocolServiceLifecycleBestEffort,
} from '@agent/core/protocol-service-lifecycle';
import {
  getRegisteredEnvText,
  isRecord,
  nowIso,
  parseSafeJsonInput,
  readTextFile,
} from '@agent/core/foundation';
import {
  backupArchiveTimeoutMs,
  interpretTarResult,
  parseManifestCredentialReads,
  repoCredentialRoots,
  resolveBackupExclusions,
  selectBackupFiles,
  selectionWarnings,
  tarExcludesFor,
  verifyWithheldCredentialMembers,
  type ManifestCredentialRead,
  type WithheldRestoreRoot,
} from './lib/backup-file-selection.js';
import {
  BACKUP_PASSPHRASE_ENV,
  BACKUP_PASSPHRASE_INTRODUCE_COMMAND,
  resolveBackupPassphrase,
  type BackupPassphraseDeps,
} from './lib/backup-passphrase.js';
export {
  describeBackupPassphraseAvailability,
  resolveBackupPassphrase,
  type BackupPassphraseAvailability,
} from './lib/backup-passphrase.js';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';
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
  /** Tenant scope: the tenant's partitions of every registered runtime root that exist. */
  tenantRuntimePartitions: TenantRuntimePartitionPath[];
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

const DEFAULT_PASSPHRASE_ENV = BACKUP_PASSPHRASE_ENV;

function usage(): string {
  return [
    'Usage:',
    '  pnpm backup create [--scope all|mission|tenant] [--mission <id>] [--tenant <slug>] [--out <archive.tar.gz.enc>] --encrypt',
    '  pnpm backup restore <archive.tar.gz.enc|archive.tar.gz> --target <clean-root> [--scope all|mission|tenant] [--tenant <slug>] [--verify-baseline] [--force]',
    '  pnpm backup list [--dir <backup-dir>]',
    '  pnpm backup prune [--dir <backup-dir>] [--retain-daily 7] [--retain-weekly 4]',
    '  pnpm backup drill [--archive <path>|--dir <backup-dir>] [--scope all|mission|tenant] [--tenant <slug>] [--target <dir under active/shared/tmp>] [--prepare-checkout] [--verify-baseline] [--force]',
    '',
    `Sensitive scopes require --encrypt and a passphrase: ${BACKUP_PASSPHRASE_INTRODUCE_COMMAND} (keychain), or ${DEFAULT_PASSPHRASE_ENV} / --passphrase-env as an override.`,
  ].join('\n');
}

/** Bad invocation: print the message (no stack trace) and exit 2. */
function usageError(message: string): ScriptExitError {
  return new ScriptExitError(2, message);
}

function readArgValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw usageError(`Missing value for ${name}`);
  }
  return value;
}

export function parseBackupArgs(argv: string[]): BackupCliOptions {
  const [command, ...rest] = argv;
  if (!['create', 'restore', 'list', 'prune', 'drill'].includes(command || '')) {
    throw usageError(usage());
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
          throw usageError(`Invalid --scope: ${scope}`);
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
        throw usageError(`Unknown argument: ${arg}\n${usage()}`);
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
  const tenantRuntimePartitions: TenantRuntimePartitionPath[] = [];

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
    // Every tenant-partitioned runtime root (ledgers, approvals, metrics and
    // the registered state roots), `<root>/<tier>/<tenant>` per tier.
    // A symlinked partition directory is never archived (it could name
    // another tenant's data or leave the repository on restore).
    const isLinked = (repoPath: string): boolean => {
      try {
        return safeLstat(path.join(rootDir, repoPath)).isSymbolicLink();
      } catch {
        return false;
      }
    };
    const plainPartition = (repoPath: string): boolean => {
      if (!pathExists(repoPath)) return false;
      if (!isLinked(repoPath)) return true;
      warnings.push(`Skipped symlinked tenant runtime partition: ${repoPath}`);
      return false;
    };
    for (const partition of tenantRuntimePartitionPaths(tenant, plainPartition)) {
      tenantRuntimePartitions.push(partition);
      entries.add(partition.path);
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
    tenantRuntimePartitions,
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

function runRequired(
  command: string,
  args: string[],
  errorPrefix: string,
  env: Record<string, string> = {},
  timeoutMs = 120000
): void {
  const result = safeExecResult(command, args, {
    timeoutMs,
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
    // Linked (2.5 GB, too large to copy). secure-io requires write scope on
    // the link target, so this last-resort fallback only works for a caller
    // that may write node_modules/ (SUDO); otherwise it fails like the
    // install attempts above.
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
    // Copied, not linked: secure-io only links to targets the caller may
    // write, and the drill must not grant the clean checkout write access to
    // the live checkout's dist/. ~110 MB, a fallback path only.
    copyTree(sourceDist, targetDist);
    return;
  }

  throw new Error(
    `clean checkout build failed: ${build.stderr || build.stdout || build.error?.message || 'failed'}`
  );
}

/** Recursive copy of regular files and directories (symlinks are skipped). */
export function copyTree(source: string, target: string): void {
  safeMkdir(target, { recursive: true });
  for (const entry of safeReaddir(source)) {
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    const stat = safeLstat(from);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) safeCopyFileSync(from, to);
  }
}

function missionGitExcludes(repos: MissionGitRepo[]): string[] {
  return repos.flatMap((repo) => ['--exclude', `${repo.repoRelativePath}/.git`]);
}

/**
 * One bundle per mission repository, aligned with `repos` (null = failed).
 * A bundle failure (e.g. macOS denying `.git/config` to a daemon) loses only
 * that mission's history: its working-tree files are still archived, so the
 * rest of the backup proceeds and the failure is reported as a warning.
 */
export function createMissionGitBundles(
  tempDir: string,
  repos: MissionGitRepo[],
  warnings: string[]
): Array<string | null> {
  if (repos.length === 0) return [];
  const bundleDir = path.join(tempDir, 'mission-git-bundles');
  safeMkdir(bundleDir);
  return repos.map((repo) => {
    const bundleName = `${repo.repoRelativePath.replace(/[\\/]+/g, '__')}.bundle`;
    const bundlePath = path.join(bundleDir, bundleName);
    const result = safeExecResult(
      'git',
      ['-C', repo.missionPath, 'bundle', 'create', bundlePath, '--all'],
      { timeoutMs: 120000, maxOutputMB: 50 }
    );
    if (result.status === 0) {
      return normalizeRepoRelative(pathResolver.rootDir(), bundlePath);
    }
    const reason = (result.stderr || result.stdout || result.error?.message || 'command failed')
      .trim()
      .split('\n')[0];
    warnings.push(
      `[BACKUP_MISSION_BUNDLE_FAILED] git bundle for ${repo.repoRelativePath} failed — its git history is not in this archive (working-tree files are) | next: give the backup process read access to ${repo.repoRelativePath}/.git (macOS: Full Disk Access for the daemon's node binary) and rerun pnpm backup create | evidence: ${reason}`
    );
    return null;
  });
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

/**
 * The archive's manifest. Tenant archives name their runtime partitions so a
 * restore can stage them; `chain_key_id` (never the key, D2) lets a restore
 * verify the chains only on a host holding the same key.
 */
export function buildBackupManifest(
  plan: BackupPlan,
  options: Pick<BackupCliOptions, 'mission' | 'tenant' | 'encrypt'>,
  context: {
    missionGitBundles: Array<string | null>;
    chainKeyId?: string;
    warnings: string[];
    excludedRoots?: string[];
    /** Guarded credential roots read under the backup admission (counts only). */
    credentialReads?: Array<{ rule_id: string; root: string; file_count: number }>;
  }
) {
  return {
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
      bundle_path: context.missionGitBundles[index] || null,
    })),
    ...(plan.scope === 'tenant'
      ? {
          tenant_runtime_partitions: plan.tenantRuntimePartitions.map((partition) => ({
            key: partition.key,
            path: partition.path,
            append_only: partition.appendOnly,
            hash_chained: partition.hashChained,
          })),
        }
      : {}),
    ...(context.chainKeyId ? { chain_key_id: context.chainKeyId } : {}),
    ...(context.excludedRoots ? { excluded_roots: context.excludedRoots } : {}),
    ...(context.credentialReads?.length ? { credential_reads: context.credentialReads } : {}),
    warnings: context.warnings,
  };
}

export function createBackup(
  options: BackupCliOptions,
  passphraseDeps: BackupPassphraseDeps = {}
): {
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
  // Fail before any expensive work (walk, bundles, tar) when the key is absent.
  const passphrase = options.encrypt
    ? resolveBackupPassphrase(options.passphraseEnv, 'create', passphraseDeps).value
    : undefined;

  safeMkdir(path.dirname(outPath));
  // The temp dir holds plaintext (payload, mission bundles): removed on every path.
  return withPlaintextTempDir(`backup-${stamp()}-${randomUUID().slice(0, 8)}`, (tempDir) => {
    const rootDir = pathResolver.rootDir();
    const manifestPath = path.join(tempDir, 'manifest.json');
    const includeListPath = path.join(tempDir, 'include.txt');
    const plainArchivePath = options.encrypt ? path.join(tempDir, 'payload.tar.gz') : outPath;
    const archivePath = options.encrypt && !outPath.endsWith('.enc') ? `${outPath}.enc` : outPath;
    const missionGitBundles = createMissionGitBundles(tempDir, plan.missionGitRepos, warnings);
    if (plan.scope === 'tenant' && options.tenant) {
      assertTenantLedgerPartitionsIntact(options.tenant, plan.tenantRuntimePartitions);
    }
    const exclusions = resolveBackupExclusions({
      rootDir,
      entries: plan.entries,
      outPath: archivePath,
      plainArchivePath,
      tempDir,
    });
    const selection = selectBackupFiles({
      rootDir,
      entries: plan.entries,
      exclusions,
      missionGitRepos: plan.missionGitRepos.map((repo) => repo.repoRelativePath),
      encrypted: options.encrypt,
    });
    warnings.push(...selectionWarnings(selection));
    // D2: the chain key itself never rides in a tenant archive; its id lets the
    // restore verify the chains only on a host holding the same key.
    const chainKeyId = currentAuditChainKeyId();

    const manifest = buildBackupManifest(plan, options, {
      missionGitBundles,
      chainKeyId,
      warnings,
      excludedRoots: exclusions.excludedRoots,
      credentialReads: selection.credentialReads,
    });
    const manifestRepoPath = normalizeRepoRelative(rootDir, manifestPath);
    safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const bundlePaths = missionGitBundles.filter((bundle): bundle is string => Boolean(bundle));
    safeWriteFile(
      includeListPath,
      [...selection.paths, ...bundlePaths, manifestRepoPath].join('\n') + '\n'
    );

    const timeoutMs = backupArchiveTimeoutMs(selection.totalBytes);
    const tarResult = safeExecResult(
      'tar',
      [
        ...tarExcludesFor(exclusions, normalizeRepoRelative(rootDir, tempDir)),
        ...missionGitExcludes(plan.missionGitRepos),
        '-czf',
        plainArchivePath,
        '-C',
        rootDir,
        '-T',
        includeListPath,
      ],
      { timeoutMs, maxOutputMB: 50 }
    );
    warnings.push(
      ...interpretTarResult(tarResult, {
        timeoutMs,
        fileCount: selection.paths.length,
        totalBytes: selection.totalBytes,
        archive: archivePath,
      }).warnings
    );

    if (options.encrypt && passphrase) {
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
        { [options.passphraseEnv]: passphrase },
        timeoutMs
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
  });
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
  tenant_runtime_partitions?: Array<{
    key: string;
    path: string;
    append_only: boolean;
    hash_chained: boolean;
  }>;
  chain_key_id?: string;
  credential_reads?: ManifestCredentialRead[];
}

const CHAIN_KEY_ID_PATTERN = /^[0-9a-f]{16}$/u;

function parseTenantRuntimePartitions(
  value: unknown
): RestoredBackupManifest['tenant_runtime_partitions'] {
  if (!Array.isArray(value))
    throw new Error('Backup manifest tenant runtime partitions are invalid.');
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      typeof entry.path !== 'string' ||
      typeof entry.append_only !== 'boolean' ||
      typeof entry.hash_chained !== 'boolean'
    ) {
      throw new Error('Backup manifest tenant runtime partition is invalid.');
    }
    return {
      key: entry.key,
      path: normalizeArchiveMember(entry.path),
      append_only: entry.append_only,
      hash_chained: entry.hash_chained,
    };
  });
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
  let chainKeyId: string | undefined;
  if (parsed.chain_key_id !== undefined) {
    if (
      typeof parsed.chain_key_id !== 'string' ||
      !CHAIN_KEY_ID_PATTERN.test(parsed.chain_key_id)
    ) {
      throw new Error('Backup manifest chain key id is invalid.');
    }
    chainKeyId = parsed.chain_key_id;
  }
  const credentialReads =
    parsed.credential_reads === undefined
      ? undefined
      : parseManifestCredentialReads(parsed.credential_reads, normalizeArchiveMember);
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
    ...(parsed.tenant_runtime_partitions !== undefined
      ? {
          tenant_runtime_partitions: parseTenantRuntimePartitions(parsed.tenant_runtime_partitions),
        }
      : {}),
    ...(chainKeyId !== undefined ? { chain_key_id: chainKeyId } : {}),
    ...(credentialReads ? { credential_reads: credentialReads } : {}),
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
  if (tenantRuntimePartitionOf(entry)?.tenant === tenant) return true;
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
    for (const partition of manifest.tenant_runtime_partitions || []) {
      if (tenantRuntimePartitionOf(partition.path)?.tenant !== manifest.tenant) {
        throw new Error(
          'Tenant backup manifest names a runtime partition outside the tenant scope.'
        );
      }
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

function validateBackupArchive(
  plainArchive: string,
  options: BackupCliOptions
): { manifest: RestoredBackupManifest; members: string[] } {
  const members = archiveMembers(plainArchive);
  const { manifest, member } = readArchiveManifest(plainArchive, members);
  validateArchiveManifestScope(manifest, member, members, options);
  return { manifest, members };
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
  const manifest = parseRestoredBackupManifest(readTextFile(manifestPath));
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

export function restoreBackup(
  options: BackupCliOptions,
  passphraseDeps: BackupPassphraseDeps = {},
  controls: {
    /**
     * Archive subtrees never written to the target (the restore drill withholds
     * credential roots so a disposable copy never holds tokens). A member that
     * still lands there (tar ignored --exclude) is removed and the restore fails.
     */
    withholdRoots?: string[];
  } = {}
): {
  target: string;
  archive: string;
  quarantinePaths: string[];
  ledger_verification: RestoredLedgerVerification;
  trimmed_tails: string[];
  withheld: WithheldRestoreRoot[];
} {
  if (!options.archive) throw new Error('restore requires an archive path');
  const archive = path.resolve(options.archive);
  if (!safeExistsSync(archive)) throw new Error(`Archive not found: ${archive}`);
  if (!options.target) throw new Error('restore requires --target <clean-root>');
  const target = path.resolve(options.target);
  const targetRel = path.relative(pathResolver.rootDir(), target);
  if (targetRel.startsWith('..') || path.isAbsolute(targetRel)) {
    throw new Error(
      `[BACKUP_RESTORE_TARGET_OUTSIDE_REPOSITORY] restore target is outside this checkout — governed I/O cannot write or verify it | next: restore under this checkout (e.g. active/shared/tmp/<restore>), or run pnpm backup restore from inside the clean checkout you are rebuilding (its --target . restores over that checkout's state; never point a drill there) | evidence: ${target}`
    );
  }
  if (safeExistsSync(target) && safeReaddir(target).length > 0 && !options.force) {
    throw new Error(`Restore target is not empty; pass --force to restore into ${target}`);
  }

  // Decrypted payload and staged partitions are plaintext: removed on every path.
  return withPlaintextTempDir(`restore-${stamp()}-${randomUUID().slice(0, 8)}`, (tempDir) => {
    const plainArchive = archive.endsWith('.enc') ? path.join(tempDir, 'payload.tar.gz') : archive;
    if (archive.endsWith('.enc')) {
      const passphrase = resolveBackupPassphrase(
        options.passphraseEnv,
        'restore',
        passphraseDeps
      ).value;
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
        { [options.passphraseEnv]: passphrase }
      );
    }

    const { manifest, members } = validateBackupArchive(plainArchive, options);
    assertNoAppendOnlyConflict(target, members);
    const tenantRestore = options.scope === 'tenant' && options.tenant ? options.tenant : undefined;
    const extracted = extractWithStagedPartitions({
      plainArchive,
      target,
      staging: path.join(tempDir, 'staged-partitions'),
      members,
      archiveChainKeyId: manifest.chain_key_id,
      tenant: tenantRestore,
      stampId: stamp(),
      withheldRoots: controls.withholdRoots,
    });
    const withheld = (controls.withholdRoots ?? []).map((root) => {
      const landed = path.join(target, root);
      if (safeExistsSync(landed)) {
        safeRmSync(landed, { recursive: true, force: true });
        throw new Error(
          `[BACKUP_RESTORE_WITHHOLD_FAILED] tar wrote withheld archive members into the target; they were removed | next: restore with a tar that honours --exclude | evidence: ${root}`
        );
      }
      return {
        root,
        archived_members: members.filter((member) => member.startsWith(`${root}/`)).length,
        manifest_file_count:
          manifest.credential_reads?.find((entry) => entry.root === root)?.file_count ?? null,
      };
    });
    const trimmedTails = extracted.trimmedTails;
    const ledgerVerification = extracted.ledgerVerification;
    const quarantinePaths: string[] = [];
    if (tenantRestore) {
      const quarantine = quarantineRestoredPeerRuntime(target, tenantRestore);
      if (quarantine.moved.length > 0) quarantinePaths.push(quarantine.quarantinePath);
    }
    quarantinePaths.push(...extracted.quarantinePaths);
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

    return {
      target,
      archive,
      quarantinePaths,
      ledger_verification: ledgerVerification,
      trimmed_tails: trimmedTails,
      withheld,
    };
  });
}

/**
 * Restore the latest (or given) archive into a disposable target, verify it,
 * then delete the target. Credential roots (connection documents, vault
 * secrets) are never extracted: the drill only checks that the archive holds
 * as many of their members as the manifest recorded, so no token copy is left
 * outside the credential deny rule (which is anchored to the live checkout).
 */
export function runRestoreDrill(options: BackupCliOptions): {
  archive: string;
  target: string;
  checkoutPrepared: boolean;
  baselineVerified: boolean;
  restoredManifestCount: number;
  quarantinePaths: string[];
  credentialMembers: WithheldRestoreRoot[];
  targetRemoved: boolean;
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
  const scratchRoot = path.resolve(pathResolver.sharedTmp());
  const target = path.resolve(
    options.target || path.join(scratchRoot, `backup-restore-drill-${stamp()}`)
  );
  assertDrillTargetConfined(target, scratchRoot, Boolean(options.force));
  if (options.force && safeExistsSync(target)) {
    safeRmSync(target, { recursive: true, force: true });
  }
  // Only a target this run creates is removed afterwards; an existing one the
  // operator pointed at (without --force) is left in place.
  const createdByDrill = !safeExistsSync(target);
  try {
    if (options.prepareCheckout) {
      safeMkdir(path.dirname(target));
      runRequired(
        'git',
        ['clone', '--local', '--no-hardlinks', '--', pathResolver.rootDir(), target],
        'clean checkout preparation failed'
      );
      if (options.verifyBaseline) {
        installCleanCheckoutDependencies(target);
        buildCleanCheckout(target);
      }
    }
    const result = restoreBackup(
      {
        ...options,
        archive,
        target,
        // Its own fresh (or freshly cloned) target is the drill's to fill.
        force: options.force || createdByDrill,
      },
      {},
      { withholdRoots: repoCredentialRoots(pathResolver.rootDir()).map(({ root }) => root) }
    );
    const credentialMembers = verifyWithheldCredentialMembers(result.withheld);
    return {
      archive: result.archive,
      target: result.target,
      checkoutPrepared: Boolean(options.prepareCheckout),
      baselineVerified: Boolean(options.verifyBaseline),
      restoredManifestCount: findRestoredManifests(result.target).length,
      quarantinePaths: result.quarantinePaths,
      credentialMembers,
      targetRemoved: createdByDrill,
    };
  } finally {
    // The restored copy is plaintext personal / confidential state: never
    // left behind when this run created it.
    if (createdByDrill) safeRmSync(target, { recursive: true, force: true });
  }
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
        ledger_verification: result.ledger_verification,
        trimmed_tail_count: result.trimmed_tails.length,
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
      ledger_verification: result.ledger_verification,
      trimmed_tails: result.trimmed_tails,
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
