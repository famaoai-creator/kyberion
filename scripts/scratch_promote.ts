/**
 * Promote a useful scratch directory (builders, ADF, notes written under
 * active/shared/tmp/<job>/ during discovery work) into a durable tool
 * directory before the tmp TTL deletes it.
 *
 *   pnpm scratch:promote --from active/shared/tmp/<job>/work --name <tool> \
 *     (--tenant <slug> | --public [--source-is-public]) [--entry <file>] [--dry-run] [--force]
 *   pnpm scratch:promote --candidate <id> --tenant <slug> --name <tool> [...]
 *
 * - --tenant <slug>: knowledge/confidential/<slug>/tools/<tool>/ (slug
 *   validated against the tenant registry; the source may be a legacy tmp
 *   path or the same tenant's confidential partition).
 * - --public: knowledge/public/tools/<tool>/ — refused when the source sits in
 *   a personal/confidential tier or a tenant-partitioned floor path, and for
 *   unpartitioned scratch (tier unknown) unless --source-is-public confirms
 *   the content is public.
 * - --candidate <id>: promote a tier-partitioned job the tmp janitor listed
 *   only by its opaque id. Under the tenant-bound role, only that tenant's
 *   own tmp/staging partitions are scanned for the job dir whose salted id
 *   matches; nothing outside the tenant is ever read.
 * - --force: replaces an earlier promotion; files listed in the previous
 *   TOOL.json but absent now are removed, and a target holding files no
 *   manifest lists is refused.
 *
 * Copies authored text files only (code, ADF/JSON, YAML, Markdown, …); skips
 * binaries and generated outputs (.pptx/.pdf/.png …), node_modules, and files
 * over the size cap. Writes TOOL.json (provenance, files + sha256,
 * entrypoints, best-effort run command, follow-up) and a short README.md, and
 * leaves a `.scratch-promoted.json` marker in the scratch directory so the tmp
 * janitor stops holding it in the code grace window.
 *
 * A tenant promotion (not --dry-run, never --public) also appends a line to
 * the tenant's information-asset ledger (`_ledger/assets.jsonl`, source_system
 * `scratch`, content hash of the written TOOL.json); the asset ref is returned
 * as `asset` and stored in the marker, not in TOOL.json (scripts/lib/promotion-ledger.ts).
 *
 * Promotion is a holding step, not the end state: the follow-up is to move
 * deterministic logic into typed actuator ops and wire a pipeline
 * (knowledge/product/orchestration/scratch-tool-promotion-playbook.md).
 */
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { nowIso, readJsonIfPresent, writeJson } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/governance';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import { loadScratchCandidateSalt, scratchCandidateId } from '@agent/core/scratch-promotion-grace';
import {
  SCRATCH_PROMOTION_MARKER,
  TOOL_MANIFEST_FILENAME,
  isAdfJsonText,
} from '@agent/core/scratch-promotion';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { guardCliArgs, hasCliFlag, type CliGuardSpec } from './lib/cli-guard.js';
import { assertPromotionSourceScope, repoRelative } from './lib/promotion-scope.js';
import {
  SCRATCH_PROMOTE_SOURCE_SYSTEM,
  commitPromotionAsset,
  planPromotionAsset,
  promotionAssetSummary,
  resolvePromotionActor,
  sha256Text,
  type PromotionAssetPlan,
} from './lib/promotion-ledger.js';

/** Scratch roots a promotion may read from (repo-relative). */
export const SCRATCH_PROMOTE_SOURCE_ROOTS = [
  'active/shared/tmp/',
  'active/shared/staging/',
  'active/missions/',
] as const;

/** Text formats that count as authored material. */
export const SCRATCH_PROMOTE_TEXT_EXTENSIONS: readonly string[] = [
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.sh',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.txt',
  '.csv',
  '.html',
  '.css',
  '.sql',
];

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist']);
export const SCRATCH_PROMOTE_MAX_FILE_BYTES = 512 * 1024;
export const SCRATCH_PROMOTE_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const SCRATCH_PROMOTE_MAX_FILES = 200;
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const SCRATCH_PROMOTE_FOLLOW_UP =
  'refactor deterministic logic into typed ops and wire a pipeline (knowledge/product/orchestration/scratch-to-pipeline-video-promotion.md)';

export interface ScratchFile {
  /** Path relative to the scratch directory (POSIX). */
  path: string;
  content: string;
  sha256: string;
}

export interface ScratchSkip {
  path: string;
  reason: string;
}

export interface ScratchCollection {
  files: ScratchFile[];
  skipped: ScratchSkip[];
}

export interface ToolManifest {
  name: string;
  promoted_at: string;
  source: { path: string; tier?: string; tenant?: string };
  target: string;
  files: Array<{ path: string; sha256: string }>;
  entrypoints: string[];
  run: string | null;
  inputs: unknown[];
  follow_up: string;
}

function fail(message: string): never {
  logger.error(message);
  throw new ScriptExitError(1, '', true);
}

function getFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function toPosix(value: string): string {
  return value.split(nodePath.sep).join('/');
}

/**
 * Lexically resolve `--from` to a repo-relative scratch directory and refuse
 * anything outside the scratch roots (no disk access: the tier guard runs
 * before any read).
 */
export function resolveScratchSourcePath(from: string): string {
  const relative = repoRelative(pathResolver.rootResolve(from)).replace(/\/+$/u, '');
  if (
    !relative ||
    relative.startsWith('..') ||
    !SCRATCH_PROMOTE_SOURCE_ROOTS.some((root) => `${relative}/`.startsWith(root)) ||
    SCRATCH_PROMOTE_SOURCE_ROOTS.includes(
      `${relative}/` as (typeof SCRATCH_PROMOTE_SOURCE_ROOTS)[number]
    )
  ) {
    throw new Error(
      `[scratch:promote] source refused — '${from}' is not a scratch job directory | ` +
        `pass a directory under ${SCRATCH_PROMOTE_SOURCE_ROOTS.join(', ')} | evidence: resolved=${relative || '(root)'}`
    );
  }
  return relative;
}

export function assertToolName(name: string | undefined): string {
  const value = String(name ?? '').trim();
  if (!TOOL_NAME_PATTERN.test(value)) {
    throw new Error(
      `[scratch:promote] invalid --name '${value}' — tool names are lowercase kebab-case (^[a-z0-9][a-z0-9-]{0,63}$) | ` +
        'pick a short descriptive name, e.g. --name board-deck-builder | evidence: --name'
    );
  }
  return value;
}

function isAuthoredTextFile(relativePath: string): boolean {
  const base = nodePath.posix.basename(relativePath);
  if (base === TOOL_MANIFEST_FILENAME || base === SCRATCH_PROMOTION_MARKER) return false;
  return SCRATCH_PROMOTE_TEXT_EXTENSIONS.includes(nodePath.posix.extname(base).toLowerCase());
}

/** Walk a scratch directory and read its authored files (secure-io, no symlinks). */
export function collectScratchFiles(sourceDir: string): ScratchCollection {
  const files: ScratchFile[] = [];
  const skipped: ScratchSkip[] = [];
  let total = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const name of [...safeReaddir(dir)].sort()) {
      const absolute = nodePath.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = safeLstat(absolute);
      if (stat.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'symlink' });
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(name)) skipped.push({ path: relative, reason: 'vendored' });
        else walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!isAuthoredTextFile(relative)) {
        skipped.push({ path: relative, reason: 'not an authored text format' });
        continue;
      }
      if (stat.size > SCRATCH_PROMOTE_MAX_FILE_BYTES) {
        skipped.push({ path: relative, reason: `over ${SCRATCH_PROMOTE_MAX_FILE_BYTES} bytes` });
        continue;
      }
      if (files.length >= SCRATCH_PROMOTE_MAX_FILES) {
        skipped.push({ path: relative, reason: `file cap ${SCRATCH_PROMOTE_MAX_FILES}` });
        continue;
      }
      if (total + stat.size > SCRATCH_PROMOTE_MAX_TOTAL_BYTES) {
        skipped.push({
          path: relative,
          reason: `total cap ${SCRATCH_PROMOTE_MAX_TOTAL_BYTES} bytes`,
        });
        continue;
      }
      const content = String(safeReadFile(absolute, { encoding: 'utf8', label: 'scratch file' }));
      total += stat.size;
      files.push({
        path: relative,
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  };
  walk(sourceDir, '');
  return { files, skipped };
}

const ENTRY_BASENAMES = ['build', 'main', 'index', 'run', 'cli'];

/** Entry points: the explicit --entry, else conventional names, else the lone code/ADF file. */
export function detectEntrypoints(files: ScratchFile[], entry?: string): string[] {
  if (entry) {
    const normalized = toPosix(entry).replace(/^\.\//u, '');
    if (!files.some((file) => file.path === normalized)) {
      throw new Error(
        `[scratch:promote] --entry '${entry}' is not among the promoted files | ` +
          'pass a path relative to --from that is an authored text file | ' +
          `evidence: files=${files.map((file) => file.path).join(',') || '(none)'}`
      );
    }
    return [normalized];
  }
  const runnable = files.filter(
    (file) =>
      /\.(m?ts|m?js|cjs|cts|py|sh)$/u.test(file.path) ||
      (file.path.endsWith('.json') && isAdfJsonText(file.content))
  );
  const conventional = runnable.filter((file) =>
    ENTRY_BASENAMES.includes(nodePath.posix.basename(file.path).replace(/\.[^.]+$/u, ''))
  );
  if (conventional.length > 0) return conventional.map((file) => file.path);
  return runnable.length === 1 ? [runnable[0].path] : [];
}

/** Best-effort run command for the first entry point, relative to the repo root. */
export function runCommandFor(
  targetRepoDir: string,
  entrypoint: string | undefined,
  files: ScratchFile[]
): string | null {
  if (!entrypoint) return null;
  const target = `${targetRepoDir}/${entrypoint}`;
  const ext = nodePath.posix.extname(entrypoint).toLowerCase();
  if (['.ts', '.mts', '.cts'].includes(ext)) return `node_modules/.bin/tsx ${target}`;
  if (['.js', '.mjs', '.cjs'].includes(ext)) return `node ${target}`;
  if (ext === '.py') return `python3 ${target}`;
  if (ext === '.sh') return `bash ${target}`;
  const file = files.find((candidate) => candidate.path === entrypoint);
  if (ext === '.json' && file && isAdfJsonText(file.content)) {
    return `pnpm pipeline --input ${target}`;
  }
  return null;
}

export function buildToolManifest(input: {
  name: string;
  sourceRepoPath: string;
  sourceTier?: string;
  sourceTenant?: string;
  targetRepoDir: string;
  files: ScratchFile[];
  entrypoints: string[];
  promotedAt: string;
}): ToolManifest {
  return {
    name: input.name,
    promoted_at: input.promotedAt,
    source: {
      path: input.sourceRepoPath,
      ...(input.sourceTier ? { tier: input.sourceTier } : {}),
      ...(input.sourceTenant ? { tenant: input.sourceTenant } : {}),
    },
    target: input.targetRepoDir,
    files: input.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    entrypoints: input.entrypoints,
    run: runCommandFor(input.targetRepoDir, input.entrypoints[0], input.files),
    inputs: [],
    follow_up: SCRATCH_PROMOTE_FOLLOW_UP,
  };
}

export function buildToolReadme(manifest: ToolManifest, scopeLabel: string): string {
  return [
    '---',
    `title: '${manifest.name} (promoted scratch tool)'`,
    `tags: [tools, scratch-promotion, ${scopeLabel}]`,
    `last_updated: ${manifest.promoted_at.slice(0, 10)}`,
    '---',
    '',
    `# ${manifest.name}`,
    '',
    `Promoted from \`${manifest.source.path}\` on ${manifest.promoted_at.slice(0, 10)} with \`pnpm scratch:promote\`.`,
    'Provenance, file hashes and entry points are in `TOOL.json`.',
    '',
    '## Run',
    '',
    manifest.run ? `\`${manifest.run}\`` : 'No entry point detected — see the files below.',
    '',
    '## Files',
    '',
    ...manifest.files.map((file) => `- \`${file.path}\``),
    '',
    '## Follow-up',
    '',
    `This is a holding copy, not the end state: ${manifest.follow_up}.`,
    '',
  ].join('\n');
}

/**
 * Re-promoting identical content keeps the earlier `promoted_at`, so TOOL.json
 * is byte-identical and its ledger content hash matches (no duplicate record).
 */
export function keepPromotedAtWhenUnchanged(
  previous: Partial<ToolManifest> | null | undefined,
  next: ToolManifest
): ToolManifest {
  if (!previous || typeof previous.promoted_at !== 'string') return next;
  const withoutTime = (value: Partial<ToolManifest>) =>
    JSON.stringify({ ...value, promoted_at: '' });
  return withoutTime(previous) === withoutTime(next)
    ? { ...next, promoted_at: previous.promoted_at }
    : next;
}

/** Tenant partitions `--candidate` may scan (the janitor's tier job dirs live there). */
export function candidateScanRoots(tenant: string): string[] {
  return ['active/shared/tmp', 'active/shared/staging'].flatMap((floor) =>
    ['confidential', 'public'].map((tier) => `${floor}/${tier}/${tenant}`)
  );
}

/**
 * Find the job dir (`<floor>/<tier>/<tenant>/<domain>/<job>`) whose salted id
 * matches, scanning only the given tenant's own partitions. Call under the
 * tenant-bound asset_promoter role.
 */
export function findScratchCandidateDir(id: string, tenant: string, salt: string): string | null {
  for (const root of candidateScanRoots(tenant)) {
    const rootPath = pathResolver.rootResolve(root);
    if (!safeExistsSync(rootPath)) continue;
    for (const domain of safeReaddir(rootPath)) {
      const domainPath = nodePath.join(rootPath, domain);
      if (!safeLstat(domainPath).isDirectory()) continue;
      for (const job of safeReaddir(domainPath)) {
        if (!safeLstat(nodePath.join(domainPath, job)).isDirectory()) continue;
        const dir = `${root}/${domain}/${job}`;
        if (scratchCandidateId(dir, salt) === id) return dir;
      }
    }
  }
  return null;
}

/** Files directly owned by the tool (never treated as stale or unlisted). */
const TOOL_OWNED_FILES = new Set([TOOL_MANIFEST_FILENAME, 'README.md']);

/**
 * --force replacement plan: files the previous manifest listed that the new
 * promotion no longer carries are removed; files in the target that no
 * manifest lists (hand-added) make the replacement unsafe.
 */
export function planForcedReplacement(input: {
  previousFiles: string[];
  existingFiles: string[];
  nextFiles: string[];
}): { remove: string[]; unlisted: string[] } {
  // A tampered manifest must not reach outside the tool directory.
  const safePrevious = input.previousFiles.filter(
    (file) =>
      file.length > 0 &&
      !file.startsWith('/') &&
      !file.includes('\\') &&
      !file.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
  const previous = new Set(safePrevious);
  const next = new Set(input.nextFiles);
  return {
    remove: safePrevious.filter((file) => !next.has(file) && !TOOL_OWNED_FILES.has(file)),
    unlisted: input.existingFiles.filter(
      (file) => !previous.has(file) && !next.has(file) && !TOOL_OWNED_FILES.has(file)
    ),
  };
}

/** Relative POSIX paths of every regular file under a directory (no symlinks). */
function listTargetFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const name of safeReaddir(dir)) {
    const absolute = nodePath.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = safeLstat(absolute);
    if (stat.isDirectory()) files.push(...listTargetFiles(absolute, relative));
    else if (stat.isFile()) files.push(relative);
  }
  return files;
}

function resolveCandidateSource(candidate: string, tenant: string | undefined): string {
  if (!tenant || !/^[0-9a-f]{16}$/u.test(candidate)) {
    fail(
      `[scratch:promote] --candidate needs a 16-hex id and --tenant <slug> (not --public, not --from) | ` +
        'copy the id from the janitor warning or scratch-promotion-candidates.json | evidence: --candidate'
    );
  }
  // Validate the tenant before any scan path is built from it.
  withExecutionContext('asset_promoter', () => resolveTenant(tenant), undefined, tenant);
  const found = withExecutionContext(
    'asset_promoter',
    () => {
      const salt = loadScratchCandidateSalt({ create: false });
      return salt ? findScratchCandidateDir(candidate, tenant, salt) : null;
    },
    undefined,
    tenant
  );
  if (!found) {
    fail(
      `[scratch:promote] candidate not found — no job dir of tenant '${tenant}' matches id ${candidate} | ` +
        'check the tenant (ids only resolve inside the owning tenant) or whether the dir was already swept | ' +
        `evidence: scanned ${candidateScanRoots(tenant).join(', ')}`
    );
  }
  return found;
}

async function main(argv: string[], print: (value: unknown) => void): Promise<void> {
  const tenant = getFlag(argv, '--tenant')?.trim().toLowerCase();
  const candidate = getFlag(argv, '--candidate')?.trim().toLowerCase();
  if (candidate && (getFlag(argv, '--from') || hasCliFlag(argv, '--public'))) {
    fail(
      '[scratch:promote] --candidate replaces --from and only targets a tenant | ' +
        'pass either --from <dir> or --candidate <id> --tenant <slug> | evidence: argv'
    );
  }
  const from = candidate ? resolveCandidateSource(candidate, tenant) : getFlag(argv, '--from');
  const isPublic = hasCliFlag(argv, '--public');
  const dryRun = hasCliFlag(argv, '--dry-run');
  const force = hasCliFlag(argv, '--force');
  const entry = getFlag(argv, '--entry');
  const sourceIsPublic = hasCliFlag(argv, '--source-is-public');
  if (!from || !getFlag(argv, '--name') || Boolean(tenant) === isPublic) {
    fail(
      '[scratch:promote] missing arguments — pass --from <dir> (or --candidate <id>) --name <tool> and exactly one of --tenant <slug> | --public | ' +
        'see pnpm scratch:promote --help | evidence: argv'
    );
  }

  let sourceRepoPath = '';
  let name = '';
  let scope: ReturnType<typeof assertPromotionSourceScope> = null;
  let targetRepoDir = '';
  let tenantKnowledgeRoot = '';
  try {
    sourceRepoPath = resolveScratchSourcePath(from);
    name = assertToolName(getFlag(argv, '--name'));
    scope = assertPromotionSourceScope(sourceRepoPath, tenant, 'scratch:promote', {
      sourceIsPublic,
    });
    if (tenant) {
      tenantKnowledgeRoot = withExecutionContext(
        'asset_promoter',
        () => resolveTenant(tenant).knowledge_root,
        undefined,
        tenant
      );
    }
    targetRepoDir = tenant
      ? `${tenantKnowledgeRoot}/tools/${name}`
      : `knowledge/public/tools/${name}`;
  } catch (err: unknown) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // All disk access runs under a narrow promoter role (security-policy.json):
  // asset_promoter bound to the target tenant (its tools/ + own scratch
  // partitions), or the unbound public_tool_promoter (knowledge/public/tools/).
  const asPromoter = <T>(fn: () => T): T =>
    tenant
      ? withExecutionContext('asset_promoter', fn, undefined, tenant)
      : withExecutionContext('public_tool_promoter', fn);
  const sourceDir = pathResolver.rootResolve(sourceRepoPath);
  const targetDir = assertSafeRepositoryPath(pathResolver.rootResolve(targetRepoDir), {
    allowMissingLeaf: true,
  });

  const collection = asPromoter(() => {
    const safeSource = assertSafeRepositoryPath(sourceDir);
    if (!safeExistsSync(safeSource) || !safeLstat(safeSource).isDirectory()) {
      throw new Error(
        `[scratch:promote] source missing — ${sourceRepoPath} is not an existing directory | ` +
          'check the path (tmp is swept after its TTL) | evidence: --from'
      );
    }
    return collectScratchFiles(safeSource);
  });
  if (collection.files.length === 0) {
    fail(
      `[scratch:promote] nothing to promote — ${sourceRepoPath} holds no authored text files | ` +
        `only ${SCRATCH_PROMOTE_TEXT_EXTENSIONS.join(' ')} are copied | evidence: skipped=${collection.skipped.length}`
    );
  }
  const manifestPath = nodePath.join(targetDir, TOOL_MANIFEST_FILENAME);
  const targetExists = asPromoter(() => safeExistsSync(targetDir));
  if (asPromoter(() => safeExistsSync(manifestPath)) && !force) {
    fail(
      `[scratch:promote] target exists — ${targetRepoDir}/${TOOL_MANIFEST_FILENAME} is already present | ` +
        'pick another --name or pass --force to overwrite | evidence: ' +
        targetRepoDir
    );
  }
  const previousManifest = asPromoter(() => readJsonIfPresent<Partial<ToolManifest>>(manifestPath));
  const replacement = asPromoter(() =>
    planForcedReplacement({
      previousFiles: (previousManifest?.files ?? []).map((file) => String(file?.path ?? '')),
      existingFiles: targetExists ? listTargetFiles(targetDir) : [],
      nextFiles: collection.files.map((file) => file.path),
    })
  );
  if (replacement.unlisted.length > 0) {
    fail(
      `[scratch:promote] target holds files no manifest lists — replacing ${targetRepoDir} could silently mix or drop them | ` +
        'move them out (or into the scratch dir) and rerun, or pick another --name | ' +
        `evidence: ${replacement.unlisted.join(', ')}`
    );
  }
  let entrypoints: string[] = [];
  try {
    entrypoints = detectEntrypoints(collection.files, entry);
  } catch (err: unknown) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const manifest = keepPromotedAtWhenUnchanged(
    previousManifest,
    buildToolManifest({
      name,
      sourceRepoPath,
      sourceTier: scope?.tier,
      sourceTenant: scope?.tenant,
      targetRepoDir,
      files: collection.files,
      entrypoints,
      promotedAt: nowIso(),
    })
  );
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const skip of collection.skipped) {
    logger.info(`[scratch:promote] skipped ${skip.path} (${skip.reason})`);
  }

  if (dryRun) {
    print({ dry_run: true, target: targetRepoDir, manifest });
    return;
  }

  // Tenant promotions become tenant information assets (DA-05 ledger). The
  // ledger line is planned before any write, so an identity or lineage
  // problem leaves the target untouched; public promotions record nothing.
  let ledgerPlan: PromotionAssetPlan | null = null;
  if (tenant) {
    const ledgerOptions = { knowledgeRoot: tenantKnowledgeRoot };
    try {
      const ingestedBy = resolvePromotionActor('[scratch:promote]');
      ledgerPlan = asPromoter(() =>
        planPromotionAsset(
          {
            tenant,
            sourceSystem: SCRATCH_PROMOTE_SOURCE_SYSTEM,
            sourceId: sourceRepoPath,
            targetPath: `${targetRepoDir}/${TOOL_MANIFEST_FILENAME}`,
            contentSha256: sha256Text(manifestText),
            transformChain: ['scratch_promote:tool'],
            ingestedBy,
            now: nowIso(),
            tag: '[scratch:promote]',
          },
          ledgerOptions
        )
      );
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  asPromoter(() => {
    for (const stale of replacement.remove) {
      const stalePath = nodePath.join(targetDir, ...stale.split('/'));
      if (safeExistsSync(stalePath)) safeUnlinkSync(stalePath);
      logger.info(`[scratch:promote] removed stale ${stale} (listed by the previous TOOL.json)`);
    }
    for (const file of collection.files) {
      safeWriteFile(nodePath.join(targetDir, ...file.path.split('/')), file.content);
    }
    writeJson(manifestPath, manifest);
    safeWriteFile(
      nodePath.join(targetDir, 'README.md'),
      buildToolReadme(manifest, tenant ?? 'public')
    );
    if (tenant && ledgerPlan) {
      commitPromotionAsset(tenant, ledgerPlan, { knowledgeRoot: tenantKnowledgeRoot });
    }
  });
  const asset = ledgerPlan ? promotionAssetSummary(ledgerPlan) : undefined;
  // Promotion record for the tmp janitor's code grace (scratch floors only).
  if (sourceRepoPath.startsWith('active/shared/')) {
    try {
      asPromoter(() =>
        writeJson(nodePath.join(sourceDir, SCRATCH_PROMOTION_MARKER), {
          promoted_at: manifest.promoted_at,
          target: targetRepoDir,
          name,
          ...(asset ? { asset: asset.ref } : {}),
        })
      );
    } catch (err: unknown) {
      logger.warn(
        `[scratch:promote] promotion marker not written — ${err instanceof Error ? err.message : String(err)} | ` +
          'the tool is promoted; the janitor may still list the scratch dir until its grace ends | ' +
          `evidence: ${sourceRepoPath}/${SCRATCH_PROMOTION_MARKER}`
      );
    }
  }
  logger.success(
    `✅ [scratch:promote] ${collection.files.length} file(s) → ${targetRepoDir} (${TOOL_MANIFEST_FILENAME}, README.md)`
  );
  print({
    target: targetRepoDir,
    files: manifest.files.length,
    skipped: collection.skipped.length,
    entrypoints: manifest.entrypoints,
    run: manifest.run,
    follow_up: manifest.follow_up,
    ...(asset ? { asset } : {}),
  });
}

/** CU-01: `--help` / typos exit before anything is copied. */
export const SCRATCH_PROMOTE_CLI: CliGuardSpec = {
  command: 'pnpm scratch:promote',
  manifestId: 'script.scratch.promote',
  options: [
    { flag: '--from', value: '<dir>' },
    { flag: '--candidate', value: '<id>' },
    { flag: '--name', value: '<tool>' },
    { flag: '--tenant', value: '<tenant-slug>' },
    { flag: '--public' },
    { flag: '--source-is-public' },
    { flag: '--entry', value: '<file>' },
    { flag: '--dry-run' },
    { flag: '--force' },
  ],
};

export const runScratchPromotion = defineScript({
  name: 'scratch:promote',
  flags: [],
  run: async ({ argv, print }) => {
    if (guardCliArgs(argv, SCRATCH_PROMOTE_CLI, print)) return;
    await main(argv, print);
  },
});

if (
  isDirectScript(import.meta.url, 'scratch_promote.ts') ||
  isDirectScript(import.meta.url, 'scratch_promote.js')
)
  void runScratchPromotion();
