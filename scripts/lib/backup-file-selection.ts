import * as path from 'node:path';
import { isRecord, parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { STORAGE_FLOOR_ROOTS } from '@agent/core/storage-layout';
import { resolveToolRuntimesRoot } from '@agent/core/tool/tool-runtime-policy';

/**
 * What a `--scope all|mission|tenant` backup hands to tar: the explicit file
 * list (no sockets, links or re-creatable floors), the tar timeout scaled to
 * that list, and the reading of tar's result. Split from scripts/backup.ts.
 */

const RETENTION_CATALOG_REPO_PATH = 'knowledge/product/governance/storage-retention-catalog.json';

/**
 * `path` + `artifact_class` of every retention catalog entry. Read directly
 * (the full loader is only reachable through the @agent/core barrel, which
 * would pull the authn providers into the backup import chain); on any read
 * problem the floors alone still apply.
 */
function readRetentionClasses(rootDir: string): Array<{ path: string; artifact_class: string }> {
  try {
    const catalogPath = path.join(rootDir, RETENTION_CATALOG_REPO_PATH);
    if (!safeExistsSync(catalogPath)) return [];
    const parsed = parseSafeJsonInput(readTextFile(catalogPath), 'Storage retention catalog');
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((entry) =>
      isRecord(entry) && typeof entry.path === 'string' && typeof entry.artifact_class === 'string'
        ? [{ path: entry.path, artifact_class: entry.artifact_class }]
        : []
    );
  } catch {
    return [];
  }
}

const BACKUP_ARCHIVE_SUFFIXES = ['.tar.gz', '.tar.gz.enc'] as const;
const DEFAULT_BACKUP_DIR_REPO_PATH = 'active/shared/exports/backups';
/** Retention classes that are re-creatable by contract and never worth archiving. */
const REGENERABLE_RETENTION_CLASSES = new Set(['cache', 'tmp']);
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

export interface BackupExclusions {
  /** Subtrees never archived (re-generable floors, backup output dir, temp dir). */
  excludedRoots: string[];
  /**
   * Exact files never archived (the archive being written, its plaintext
   * payload, the backup passphrase's connection document).
   */
  excludedFiles: string[];
  /** Directories whose existing backup archives are skipped (`*.tar.gz[.enc]`). */
  archiveDirs: string[];
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
  retentionEntries?: Array<{ path: string; artifact_class: string }>;
  /** Override for tests; defaults to the managed tool-runtime install root. */
  toolRuntimesRoot?: string | null;
}

/**
 * What a backup leaves out, derived from the storage layout instead of a
 * hand-kept list: the scratch / staging / cache floors and every retention
 * catalog entry classed `cache` or `tmp` are re-creatable by contract, the
 * backup output directory must never archive itself, and the managed
 * tool-runtime install tree keeps only its provenance files. A root that
 * equals or contains an explicitly planned entry (e.g. a tenant's partition
 * under a cache-classed root) is not excluded: an explicit scope wins.
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
      .filter((entry) => REGENERABLE_RETENTION_CLASSES.has(entry.artifact_class))
      .map((entry) => entry.path),
  ].filter((root) => !coversPlannedEntry(root));

  const outputDir = repoRelativeOrNull(rootDir, input.outPath && path.dirname(input.outPath));
  const excludedRoots = new Set<string>([...regenerable, DEFAULT_BACKUP_DIR_REPO_PATH]);
  const tempRel = repoRelativeOrNull(rootDir, input.tempDir);
  if (tempRel) excludedRoots.add(tempRel);

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
    provenanceOnlyRoots,
  };
}

export interface BackupFileSelection {
  /** Repo-relative paths handed to tar (`-T`): regular files and empty directories. */
  paths: string[];
  /** Directories secure-io would not list; tar archives them recursively. */
  unlisted: string[];
  totalBytes: number;
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
}): BackupFileSelection {
  const { rootDir, exclusions } = input;
  const missionGitDirs = new Set((input.missionGitRepos || []).map((repo) => `${repo}/.git`));
  const excludedFiles = new Set(exclusions.excludedFiles);
  const archiveDirs = new Set(exclusions.archiveDirs);
  const selection: BackupFileSelection = {
    paths: [],
    unlisted: [],
    totalBytes: 0,
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
      `Archived ${hardLinks.length} repeated hard link(s) once; a restore refuses link members: ${sampleList(hardLinks)}`
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
