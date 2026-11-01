import * as path from 'node:path';
import { isRecord, parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import {
  BACKUP_READABLE_CREDENTIAL_RULE_IDS,
  listSensitivePathRoots,
  withBackupCredentialReadAdmission,
} from '@agent/core/sensitive-path-policy';
import { STORAGE_FLOOR_ROOTS } from '@agent/core/storage-layout';
import { resolveToolRuntimesRoot } from '@agent/core/tool/tool-runtime-policy';

/**
 * What a `--scope all|mission|tenant` backup hands to tar: the explicit file
 * list (no sockets, links or re-creatable floors), the tar timeout scaled to
 * that list, and the reading of tar's result. Split from scripts/backup.ts.
 */

const RETENTION_CATALOG_REPO_PATH = 'knowledge/product/governance/storage-retention-catalog.json';

/** The fields of a retention catalog entry the backup selection reads. */
export interface BackupRetentionEntry {
  path: string;
  artifact_class: string;
  /** Explicit opt-out: only `exclude` keeps an entry out of the archive. */
  backup?: string;
}

/**
 * `path`, `artifact_class` and `backup` of every retention catalog entry. Read
 * directly (the full loader is only reachable through the @agent/core barrel,
 * which would pull the authn providers into the backup import chain); on any
 * read problem the floors alone still apply.
 */
function readRetentionClasses(rootDir: string): BackupRetentionEntry[] {
  try {
    const catalogPath = path.join(rootDir, RETENTION_CATALOG_REPO_PATH);
    if (!safeExistsSync(catalogPath)) return [];
    const parsed = parseSafeJsonInput(readTextFile(catalogPath), 'Storage retention catalog');
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((entry) =>
      isRecord(entry) && typeof entry.path === 'string' && typeof entry.artifact_class === 'string'
        ? [
            {
              path: entry.path,
              artifact_class: entry.artifact_class,
              ...(typeof entry.backup === 'string' ? { backup: entry.backup } : {}),
            },
          ]
        : []
    );
  } catch {
    return [];
  }
}

const BACKUP_ARCHIVE_SUFFIXES = ['.tar.gz', '.tar.gz.enc'] as const;
const DEFAULT_BACKUP_DIR_REPO_PATH = 'active/shared/exports/backups';
/** Catalog opt-out value (storage-retention-catalog.schema.json `backup`). */
const BACKUP_EXCLUDE = 'exclude';
const SAMPLE_LIMIT = 5;

/**
 * The connection document (and its rotation backup) that
 * `pnpm kyberion secret introduce kyberion-backup PASSPHRASE` dual-writes next
 * to the keychain entry: never archived, so the backup passphrase can never
 * ride inside the archive it encrypts (scripts/lib/backup-passphrase.ts).
 */
export const BACKUP_PASSPHRASE_CONNECTION_FILES = [
  'knowledge/personal/connections/kyberion-backup.json',
  'knowledge/personal/connections/kyberion-backup.json.bak',
] as const;

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function repoRelativeOrNull(rootDir: string, target: string | undefined): string | null {
  if (!target) return null;
  const rel = path.relative(rootDir, path.resolve(target)).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Repo-relative roots of every sensitive-path credential rule that lies inside
 * this checkout (e.g. `vault/secrets`, `knowledge/personal/connections`).
 */
export function repoCredentialRoots(
  rootDir: string,
  sensitiveRoots: Array<{ ruleId: string; root: string }> = listSensitivePathRoots()
): Array<{ ruleId: string; root: string }> {
  return sensitiveRoots.flatMap(({ ruleId, root }) => {
    const rel = repoRelativeOrNull(rootDir, root);
    return rel ? [{ ruleId, root: rel }] : [];
  });
}

/** A manifest `credential_reads` record: a guarded root the backup read, and how many files. */
export interface ManifestCredentialRead {
  rule_id: string;
  root: string;
  file_count: number;
  /**
   * True when the walk could not count the root's files: an ancestor was not
   * listable by secure-io (e.g. the personal tier), so tar archived that
   * subtree itself. `file_count` is then 0 and carries no information.
   */
  uncounted?: true;
}

/** Validate a restored manifest's `credential_reads` (roots via the archive member normalizer). */
export function parseManifestCredentialReads(
  value: unknown,
  normalizeRoot: (root: string) => string
): ManifestCredentialRead[] {
  if (!Array.isArray(value)) throw new Error('Backup manifest credential reads are invalid.');
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.rule_id !== 'string' ||
      typeof entry.root !== 'string' ||
      typeof entry.file_count !== 'number' ||
      !Number.isInteger(entry.file_count) ||
      entry.file_count < 0 ||
      (entry.uncounted !== undefined && entry.uncounted !== true)
    ) {
      throw new Error('Backup manifest credential read is invalid.');
    }
    return {
      rule_id: entry.rule_id,
      root: normalizeRoot(entry.root),
      file_count: entry.file_count,
      ...(entry.uncounted === true ? { uncounted: true as const } : {}),
    };
  });
}

/**
 * The file count a manifest recorded for `root`, or null when it recorded
 * none or could not count it (`uncounted`: tar archived an unlisted ancestor).
 */
export function manifestCredentialCount(
  reads: ManifestCredentialRead[] | undefined,
  root: string
): number | null {
  const entry = reads?.find((read) => read.root === root);
  if (!entry || entry.uncounted) return null;
  return entry.file_count;
}

/** One archive subtree a restore withheld from the target, with what the archive holds. */
export interface WithheldRestoreRoot {
  root: string;
  /** Archive members strictly inside `root`. */
  archived_members: number;
  /** `credential_reads[].file_count` the manifest recorded for `root`, if any. */
  manifest_file_count: number | null;
}

/**
 * The restore drill's credential check: the withheld roots the archive or its
 * manifest mentions, refusing any whose archived member count differs from
 * what the manifest recorded at backup time.
 */
export function verifyWithheldCredentialMembers(
  withheld: WithheldRestoreRoot[]
): WithheldRestoreRoot[] {
  const present = withheld.filter(
    (entry) => entry.archived_members > 0 || entry.manifest_file_count !== null
  );
  const mismatched = present.filter(
    (entry) =>
      entry.manifest_file_count !== null && entry.manifest_file_count !== entry.archived_members
  );
  if (mismatched.length > 0) {
    throw new Error(
      `[BACKUP_DRILL_CREDENTIAL_COUNT_MISMATCH] the archive does not hold the credential documents its manifest recorded | next: take a fresh encrypted backup and drill it again | evidence: ${mismatched
        .map(
          (entry) =>
            `${entry.root}: archived ${entry.archived_members}, manifest ${entry.manifest_file_count}`
        )
        .join('; ')}`
    );
  }
  return present;
}

export interface BackupExclusions {
  /**
   * Subtrees never archived (re-generable floors, `backup: "exclude"` catalog
   * entries, credential roots guarded by the sensitive-path policy, backup
   * output dir, temp dir).
   */
  excludedRoots: string[];
  /**
   * Exact files never archived (the archive being written, its plaintext
   * payload, the backup passphrase's connection document).
   */
  excludedFiles: string[];
  /** Directories whose existing backup archives are skipped (`*.tar.gz[.enc]`). */
  archiveDirs: string[];
  /**
   * Backup-readable credential roots (connection documents) that overlap the
   * planned entries: walked only under the encrypted-archive read admission.
   */
  credentialReadRoots: Array<{ ruleId: string; root: string }>;
  /**
   * Install trees kept only for provenance: `<root>/<runtime>/state.json` and
   * top-level regular files ride along, the reinstallable payload does not.
   */
  provenanceOnlyRoots: string[];
}

export interface BackupExclusionInput {
  rootDir: string;
  entries: string[];
  outPath?: string;
  plainArchivePath?: string;
  tempDir?: string;
  /** Override for tests; defaults to the governed storage retention catalog. */
  retentionEntries?: BackupRetentionEntry[];
  /** Override for tests; defaults to the managed tool-runtime install root. */
  toolRuntimesRoot?: string | null;
  /** Override for tests; absolute credential roots, defaults to the sensitive-path policy. */
  sensitiveRoots?: Array<{ ruleId: string; root: string }>;
}

/**
 * What a backup leaves out, derived from the storage layout instead of a
 * hand-kept list: the scratch / staging / cache floors, plus every retention
 * catalog entry that opts out with `backup: "exclude"` (fully regenerable
 * data). A `cache`/`tmp` class alone does not exclude — staging stores such
 * as distill or promotion candidates and queued events are pending state a
 * restore needs. The backup output directory must never archive itself, and
 * the managed tool-runtime install tree keeps only its provenance files. A
 * root that equals or contains an explicitly planned entry (e.g. a tenant's
 * partition under an excluded root) is not excluded: an explicit scope wins.
 * Credential roots of the sensitive-path policy that overlap a planned entry
 * are never walked freely: the backup-readable ones (connection documents a
 * restore needs) become `credentialReadRoots`, read only under the
 * encrypted-archive admission; every other one (e.g. `vault/secrets`, a
 * registry of keychain entry names whose secrets live in the OS keychain) is
 * always excluded, even when an explicit scope lies inside it.
 */
export function resolveBackupExclusions(input: BackupExclusionInput): BackupExclusions {
  const { rootDir, entries } = input;
  const retentionEntries = input.retentionEntries ?? readRetentionClasses(rootDir);
  const coversPlannedEntry = (root: string): boolean =>
    entries.some((entry) => isWithin(entry, root));

  const regenerable = [
    STORAGE_FLOOR_ROOTS.scratch,
    STORAGE_FLOOR_ROOTS.staging,
    STORAGE_FLOOR_ROOTS.cache,
    ...retentionEntries
      .filter((entry) => entry.backup === BACKUP_EXCLUDE)
      .map((entry) => entry.path),
  ].filter((root) => !coversPlannedEntry(root));

  const outputDir = repoRelativeOrNull(rootDir, input.outPath && path.dirname(input.outPath));
  const excludedRoots = new Set<string>([...regenerable, DEFAULT_BACKUP_DIR_REPO_PATH]);
  const tempRel = repoRelativeOrNull(rootDir, input.tempDir);
  if (tempRel) excludedRoots.add(tempRel);
  const credentialReadRoots: Array<{ ruleId: string; root: string }> = [];
  for (const { ruleId, root: rel } of repoCredentialRoots(rootDir, input.sensitiveRoots)) {
    if (!entries.some((entry) => isWithin(rel, entry) || isWithin(entry, rel))) continue;
    if (BACKUP_READABLE_CREDENTIAL_RULE_IDS.includes(ruleId)) {
      credentialReadRoots.push({ ruleId, root: rel });
    } else {
      excludedRoots.add(rel);
    }
  }

  const excludedFiles = new Set<string>(BACKUP_PASSPHRASE_CONNECTION_FILES);
  for (const target of [input.outPath, input.plainArchivePath]) {
    const rel = repoRelativeOrNull(rootDir, target);
    if (rel) excludedFiles.add(rel);
  }

  let toolRuntimesRoot = input.toolRuntimesRoot;
  if (toolRuntimesRoot === undefined) {
    try {
      toolRuntimesRoot = repoRelativeOrNull(rootDir, resolveToolRuntimesRoot());
    } catch {
      toolRuntimesRoot = null;
    }
  }
  const provenanceOnlyRoots =
    toolRuntimesRoot && !coversPlannedEntry(toolRuntimesRoot) ? [toolRuntimesRoot] : [];

  return {
    excludedRoots: [...excludedRoots].sort(),
    excludedFiles: [...excludedFiles].sort(),
    archiveDirs: outputDir ? [outputDir] : [],
    credentialReadRoots,
    provenanceOnlyRoots,
  };
}

export interface BackupFileSelection {
  /** Repo-relative paths handed to tar (`-T`): regular files and empty directories. */
  paths: string[];
  /** Directories secure-io would not list; tar archives them recursively. */
  unlisted: string[];
  totalBytes: number;
  /** What the walk read under the backup credential admission: roots and counts, never contents. */
  credentialReads: ManifestCredentialRead[];
  skipped: {
    excluded: number;
    nonRegular: string[];
    symlinks: string[];
    hardLinks: string[];
  };
}

/**
 * Walk the planned entries and choose exactly what tar archives. Building the
 * list here (instead of letting tar recurse) is what keeps sockets, FIFOs and
 * devices out (bsdtar's pax writer aborts on a socket), and symlinks / repeat
 * hard links out (a restore refuses those members). Mission `.git` directories
 * are skipped because they ride as bundles.
 */
export function selectBackupFiles(input: {
  rootDir: string;
  entries: string[];
  exclusions: BackupExclusions;
  missionGitRepos?: string[];
  /** Whether the archive is encrypted; required to walk any credential read root. */
  encrypted?: boolean;
}): BackupFileSelection {
  const { exclusions } = input;
  if (exclusions.credentialReadRoots.length === 0) return walkBackupFiles(input);
  // Connection documents ride only inside an encrypted archive, read-only,
  // and only for this walk; the counts land in the manifest.
  return withBackupCredentialReadAdmission({ encrypted: input.encrypted === true }, () => {
    const selection = walkBackupFiles(input);
    selection.credentialReads = exclusions.credentialReadRoots.map(({ ruleId, root }) => {
      // An unlisted ancestor (e.g. the personal tier this role may not list)
      // is archived by tar itself, so the walk never sees the root's files.
      const archivedByTar = selection.unlisted.some((rel) => isWithin(root, rel));
      return archivedByTar
        ? { rule_id: ruleId, root, file_count: 0, uncounted: true as const }
        : {
            rule_id: ruleId,
            root,
            file_count: selection.paths.filter((rel) => isWithin(rel, root)).length,
          };
    });
    return selection;
  });
}

function walkBackupFiles(input: {
  rootDir: string;
  entries: string[];
  exclusions: BackupExclusions;
  missionGitRepos?: string[];
}): BackupFileSelection {
  const { rootDir, exclusions } = input;
  const missionGitDirs = new Set((input.missionGitRepos || []).map((repo) => `${repo}/.git`));
  const excludedFiles = new Set(exclusions.excludedFiles);
  const archiveDirs = new Set(exclusions.archiveDirs);
  const selection: BackupFileSelection = {
    paths: [],
    unlisted: [],
    totalBytes: 0,
    credentialReads: [],
    skipped: { excluded: 0, nonRegular: [], symlinks: [], hardLinks: [] },
  };
  const seenInodes = new Set<string>();

  const isExcluded = (rel: string): boolean =>
    excludedFiles.has(rel) ||
    missionGitDirs.has(rel) ||
    exclusions.excludedRoots.some((root) => isWithin(rel, root)) ||
    (archiveDirs.has(path.posix.dirname(rel)) &&
      BACKUP_ARCHIVE_SUFFIXES.some((suffix) => rel.endsWith(suffix)));

  /** Inside a provenance-only root, keep `<runtime>/state.json` and top-level files only. */
  const provenanceVerdict = (rel: string, isDir: boolean): 'keep' | 'skip' | 'descend' => {
    for (const root of exclusions.provenanceOnlyRoots) {
      if (!rel.startsWith(`${root}/`)) continue;
      const parts = rel.slice(root.length + 1).split('/');
      if (parts.length === 1) return isDir ? 'descend' : 'keep';
      if (parts.length === 2 && !isDir && parts[1] === 'state.json') return 'keep';
      return 'skip';
    }
    return 'keep';
  };

  const stack = [...input.entries].reverse();
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    if (isExcluded(rel)) {
      selection.skipped.excluded += 1;
      continue;
    }
    const full = path.join(rootDir, rel);
    let stat;
    try {
      stat = safeLstat(full);
    } catch {
      if (!safeExistsSync(full)) continue;
      selection.unlisted.push(rel);
      selection.paths.push(rel);
      continue;
    }
    if (stat.isSymbolicLink()) {
      selection.skipped.symlinks.push(rel);
      continue;
    }
    if (stat.isDirectory()) {
      const verdict = provenanceVerdict(rel, true);
      if (verdict === 'skip') {
        selection.skipped.excluded += 1;
        continue;
      }
      let children: string[];
      try {
        children = safeReaddir(full);
      } catch {
        selection.unlisted.push(rel);
        selection.paths.push(rel);
        continue;
      }
      if (children.length === 0) {
        selection.paths.push(rel);
        continue;
      }
      for (const child of [...children].sort().reverse()) stack.push(`${rel}/${child}`);
      continue;
    }
    if (!stat.isFile()) {
      selection.skipped.nonRegular.push(rel);
      continue;
    }
    if (provenanceVerdict(rel, false) === 'skip') {
      selection.skipped.excluded += 1;
      continue;
    }
    if (stat.nlink > 1) {
      const inode = `${stat.dev}:${stat.ino}`;
      if (seenInodes.has(inode)) {
        selection.skipped.hardLinks.push(rel);
        continue;
      }
      seenInodes.add(inode);
    }
    selection.paths.push(rel);
    selection.totalBytes += stat.size;
  }
  return selection;
}

function sampleList(items: string[]): string {
  const head = items.slice(0, SAMPLE_LIMIT).join(', ');
  return items.length > SAMPLE_LIMIT ? `${head}, … (+${items.length - SAMPLE_LIMIT})` : head;
}

/** Operator-facing warnings for what the selection dropped or could not walk. */
export function selectionWarnings(selection: BackupFileSelection): string[] {
  const warnings: string[] = [];
  const { nonRegular, symlinks, hardLinks } = selection.skipped;
  if (nonRegular.length > 0) {
    warnings.push(
      `Skipped ${nonRegular.length} non-regular file(s) (sockets, FIFOs, devices): ${sampleList(nonRegular)}`
    );
  }
  if (symlinks.length > 0) {
    warnings.push(
      `Skipped ${symlinks.length} symlink(s); a restore refuses link members: ${sampleList(symlinks)}`
    );
  }
  if (hardLinks.length > 0) {
    warnings.push(
      `Skipped ${hardLinks.length} repeated hard link(s): only the first path of each inode is archived (a restore refuses link members), so these paths are absent from the archive: ${sampleList(hardLinks)}`
    );
  }
  if (selection.unlisted.length > 0) {
    warnings.push(
      `secure-io could not list ${selection.unlisted.length} path(s); tar archives them unfiltered: ${sampleList(selection.unlisted)}`
    );
  }
  return warnings;
}

/** tar `--exclude` arguments for subtrees tar walks itself (unlisted paths only). */
export function tarExcludesFor(exclusions: BackupExclusions, tempDirRel: string | null): string[] {
  const excludes = [
    // A root that contains the temp dir would also drop the manifest and bundles.
    ...exclusions.excludedRoots.filter((root) => !tempDirRel || !isWithin(tempDirRel, root)),
    ...exclusions.excludedFiles,
  ];
  return [...new Set(excludes)].flatMap((entry) => ['--exclude', entry]);
}

const ARCHIVE_TIMEOUT_BASE_MS = 10 * 60 * 1000;
const ARCHIVE_TIMEOUT_MAX_MS = 6 * 60 * 60 * 1000;
/** Conservative gzip+disk throughput floor used to scale the tar timeout. */
const ARCHIVE_MIN_BYTES_PER_SECOND = 4 * 1024 * 1024;

/** tar timeout proportional to the selected payload: 10 min + 1 s per 4 MiB, capped at 6 h. */
export function backupArchiveTimeoutMs(totalBytes: number): number {
  const scaled =
    ARCHIVE_TIMEOUT_BASE_MS +
    Math.ceil(Math.max(0, totalBytes) / ARCHIVE_MIN_BYTES_PER_SECOND) * 1000;
  return Math.min(ARCHIVE_TIMEOUT_MAX_MS, scaled);
}

const TOLERATED_TAR_STDERR =
  /No such file or directory|file changed as we read it|Error exit delayed from previous errors|Removing leading/i;

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Turn a tar result into success (+ warnings) or a diagnostic error. A file
 * that vanished between the walk and tar (rotated log, released lock) is a
 * warning, not a failed backup; a timeout names the size and the limit.
 */
export function interpretTarResult(
  result: { status: number | null; stdout: string; stderr: string; error?: Error },
  context: { timeoutMs: number; fileCount: number; totalBytes: number; archive: string }
): { warnings: string[] } {
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === 'ETIMEDOUT' || /ETIMEDOUT|timed out/i.test(result.error?.message || '')) {
    throw new Error(
      `[BACKUP_ARCHIVE_TIMEOUT] tar did not finish within ${Math.round(context.timeoutMs / 1000)}s — the selected payload is ${context.fileCount} files / ${formatBytes(context.totalBytes)} and the limit scales at ${ARCHIVE_MIN_BYTES_PER_SECOND / (1024 * 1024)} MiB/s (cap ${ARCHIVE_TIMEOUT_MAX_MS / 3600000}h) | next: check disk I/O load and free space, write --out to a faster volume, or move bulky re-generable data onto a cache/tmp floor so it is excluded | evidence: ${context.archive}`
    );
  }
  if (result.status === 0) return { warnings: [] };
  const lines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    result.status === 1 &&
    lines.length > 0 &&
    lines.every((line) => TOLERATED_TAR_STDERR.test(line))
  ) {
    const vanished = lines.filter((line) => !/Error exit delayed|Removing leading/i.test(line));
    return {
      warnings: vanished.length
        ? [
            `tar skipped ${vanished.length} path(s) that changed or vanished during the backup: ${sampleList(vanished)}`,
          ]
        : [],
    };
  }
  throw new Error(
    `backup archive creation failed: ${result.stderr || result.stdout || result.error?.message || 'command failed'}`
  );
}
