/**
 * Scratch promotion grace for the tmp sweep (storage-janitor `scanTmp`).
 *
 * An unpromoted tmp job directory that holds authored code or ADF keeps its
 * files `code_grace_days` beyond the tmp TTL. While the grace runs the sweep
 * warns (diagnostic format) with the exact `pnpm scratch:promote` command and
 * lists the directory in the system-partition state file
 * `active/shared/runtime/system/scratch-promotion-candidates.json`, which is
 * rewritten whole on every non-dry run so it only lists live grace windows.
 * Classifiers live in scratch-promotion.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as nodePath from 'node:path';
import { loadJsonIfPresent, writeJson } from './foundation/json.js';
import { rootDir, shared } from './path-resolver.js';
import { safePublishExclusiveFileSync, safeReadFile, safeStat } from './secure-io.js';
import { logger } from './core.js';
import {
  ADF_SNIFF_MAX_BYTES,
  DEFAULT_CODE_GRACE_DAYS,
  SCRATCH_PROMOTION_CANDIDATES_SUBPATH,
  SCRATCH_PROMOTION_SALT_SUBPATH,
  classifyPromotionSourceScope,
  isAuthoredScratchFile,
  isScratchPromotionRecord,
  scratchJobDirFor,
  scratchPromoteCommand,
  type ScratchPromotionCandidate,
  type ScratchPromotionCandidatesFile,
} from './scratch-promotion.js';
import { STORAGE_FLOOR_ROOTS, SYSTEM_PARTITION_SEGMENT } from './storage-layout.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CANDIDATES_REPO_PATH = `active/shared/${SCRATCH_PROMOTION_CANDIDATES_SUBPATH}`;
const SCRATCH_TMP_FLOOR = STORAGE_FLOOR_ROOTS.scratch;

interface ScratchJobState {
  /** Job-relative authored files (code or ADF). */
  authored: string[];
  promoted: boolean;
  fileCount: number;
  /** Earliest end of the code grace among this job's files already past the TTL. */
  graceUntilMs: number | null;
}

export interface ScratchCodeGracePlan {
  graceDays: number;
  graceMs: number;
  jobs: Map<string, ScratchJobState>;
}

function repoRelative(absolutePath: string): string {
  return nodePath.relative(rootDir(), absolutePath).split(nodePath.sep).join('/');
}

/** Read a small `.json` file for ADF detection; null when unreadable or too large. */
function readScratchJsonText(filePath: string, size: number): string | null {
  if (size > ADF_SNIFF_MAX_BYTES) return null;
  try {
    return String(safeReadFile(filePath, { encoding: 'utf8', label: 'scratch json' }));
  } catch {
    return null;
  }
}

/**
 * Group tmp files by job directory and mark the jobs that hold authored code
 * or ADF and carry no promotion record. Only jobs with at least one file past
 * the TTL are classified (nothing else can be deleted this run), and code
 * extensions are checked before any `.json` is read. `graceDays <= 0`
 * disables the grace.
 */
export function planScratchCodeGrace(
  files: string[],
  stats: Map<string, { mtimeMs: number; size: number }>,
  graceDays: number,
  ttlMs: number,
  nowMs: number
): ScratchCodeGracePlan {
  const jobs = new Map<string, ScratchJobState>();
  const plan = { graceDays, graceMs: Math.max(0, graceDays) * DAY_MS, jobs };
  if (plan.graceMs === 0) return plan;
  const byJob = new Map<string, string[]>();
  for (const filePath of files) {
    const jobDir = scratchJobDirFor(repoRelative(filePath));
    if (!jobDir) continue;
    const group = byJob.get(jobDir);
    if (group) group.push(filePath);
    else byJob.set(jobDir, [filePath]);
  }
  for (const [jobDir, jobFiles] of byJob) {
    const pastTtl = jobFiles.some((filePath) => {
      const stat = stats.get(filePath);
      return stat !== undefined && nowMs - stat.mtimeMs > ttlMs;
    });
    if (!pastTtl) continue;
    const relativeOf = (filePath: string) => repoRelative(filePath).slice(jobDir.length + 1);
    const job: ScratchJobState = {
      authored: [],
      promoted: jobFiles.some(isScratchPromotionRecord),
      fileCount: jobFiles.length,
      graceUntilMs: null,
    };
    jobs.set(jobDir, job);
    if (job.promoted) continue;
    const noJson = () => null;
    job.authored = jobFiles.filter((p) => isAuthoredScratchFile(p, noJson)).map(relativeOf);
    if (job.authored.length > 0) continue;
    job.authored = jobFiles
      .filter((p) =>
        isAuthoredScratchFile(p, (q) =>
          readScratchJsonText(q, stats.get(q)?.size ?? Number.POSITIVE_INFINITY)
        )
      )
      .map(relativeOf);
  }
  return plan;
}

/**
 * True when an expired tmp file must be kept because its job directory is an
 * unpromoted, code-bearing scratch dir still inside `ttl + code_grace_days`.
 */
export function holdForScratchCodeGrace(
  plan: ScratchCodeGracePlan,
  filePath: string,
  mtimeMs: number,
  ttlMs: number,
  nowMs: number
): boolean {
  if (plan.graceMs === 0) return false;
  const jobDir = scratchJobDirFor(repoRelative(filePath));
  const job = jobDir ? plan.jobs.get(jobDir) : undefined;
  if (!job || job.authored.length === 0 || job.promoted) return false;
  const graceUntil = mtimeMs + ttlMs + plan.graceMs;
  if (nowMs > graceUntil) return false;
  job.graceUntilMs =
    job.graceUntilMs === null ? graceUntil : Math.min(job.graceUntilMs, graceUntil);
  return true;
}

/**
 * The tmp files past the TTL that may be deleted now, plus the grace plan
 * (which records the job directories held back this run).
 */
export function selectExpiredTmpFiles(
  files: string[],
  ttlMs: number,
  nowMs: number,
  graceDays: number = DEFAULT_CODE_GRACE_DAYS
): { expired: string[]; grace: ScratchCodeGracePlan } {
  const stats = new Map<string, { mtimeMs: number; size: number }>();
  for (const filePath of files) {
    try {
      const stat = safeStat(filePath);
      stats.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // vanished or unreadable — skip, as the sweep always has
    }
  }
  const grace = planScratchCodeGrace(files, stats, graceDays, ttlMs, nowMs);
  const expired = files.filter((filePath) => {
    const stat = stats.get(filePath);
    if (!stat || nowMs - stat.mtimeMs <= ttlMs) return false;
    return !holdForScratchCodeGrace(grace, filePath, stat.mtimeMs, ttlMs, nowMs);
  });
  return { expired, grace };
}

function readCandidatesFile(filePath: string): ScratchPromotionCandidatesFile | null {
  try {
    const parsed = loadJsonIfPresent<ScratchPromotionCandidatesFile>(filePath);
    return parsed && Array.isArray(parsed.candidates) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Warn about, and record, the job directories held this run. The state file
 * lives in the system partition, which carries no tenant data: a
 * tier-partitioned job is recorded only as an opaque id + tier (no tenant
 * slug, job name or file names), and file names of unpartitioned (legacy)
 * jobs are withheld too. Only system-partition jobs list their files.
 */
export function reportScratchCodeGrace(
  plan: ScratchCodeGracePlan,
  nowMs: number,
  dryRun: boolean
): ScratchPromotionCandidate[] {
  try {
    return reportScratchCodeGraceUnsafe(plan, nowMs, dryRun);
  } catch (err) {
    logger.warn(
      `[JANITOR] scratch promotion grace report failed — ${err instanceof Error ? err.message : String(err)} | ` +
        'the deletion deferral still applied; rerun the janitor | evidence: storage-janitor scanTmp'
    );
    return [];
  }
}

/**
 * Per-install random salt for candidate ids (system partition). Without it an
 * id would be an unsalted hash of the path, letting anyone who can read the
 * candidates file confirm a guessed tenant/job path. Created on first use;
 * `create: false` returns null when it does not exist yet.
 */
export function loadScratchCandidateSalt(options: { create: boolean }): string | null {
  const saltPath = shared(SCRATCH_PROMOTION_SALT_SUBPATH);
  const read = (): string | null => {
    const salt = loadJsonIfPresent<{ salt?: unknown }>(saltPath)?.salt;
    return typeof salt === 'string' && /^[0-9a-f]{64}$/u.test(salt) ? salt : null;
  };
  const existing = read();
  if (existing || !options.create) return existing;
  const salt = randomBytes(32).toString('hex');
  try {
    // Exclusive create: a concurrent janitor run keeps the first salt.
    safePublishExclusiveFileSync(saltPath, `${JSON.stringify({ salt }, null, 2)}\n`);
    return salt;
  } catch {
    return read();
  }
}

/** Opaque, stable candidate id for a job directory (salted, see loadScratchCandidateSalt). */
export function scratchCandidateId(dir: string, salt: string): string {
  return createHash('sha256').update(`${salt}\0${dir}`).digest('hex').slice(0, 16);
}

/** The command shown for a tier-partitioned candidate (no dir, no tenant slug). */
export function scratchCandidatePromoteCommand(id: string): string {
  return `pnpm scratch:promote --candidate ${id} --tenant <slug> --name <tool>`;
}

function describeCandidate(
  dir: string,
  job: ScratchJobState,
  salt: string
): Pick<ScratchPromotionCandidate, 'id' | 'dir' | 'tier' | 'files' | 'files_redacted' | 'command'> {
  const id = scratchCandidateId(dir, salt);
  const scope = classifyPromotionSourceScope(dir);
  if (scope) {
    return {
      id,
      tier: scope.tier,
      files: [],
      files_redacted: true,
      command: scratchCandidatePromoteCommand(id),
    };
  }
  const isSystem = dir.startsWith(`${SCRATCH_TMP_FLOOR}/${SYSTEM_PARTITION_SEGMENT}/`);
  return {
    id,
    dir,
    files: isSystem ? [...job.authored].sort() : [],
    ...(isSystem ? {} : { files_redacted: true }),
    command: scratchPromoteCommand({ dir }),
  };
}

function reportScratchCodeGraceUnsafe(
  plan: ScratchCodeGracePlan,
  nowMs: number,
  dryRun: boolean
): ScratchPromotionCandidate[] {
  const candidatesPath = shared(SCRATCH_PROMOTION_CANDIDATES_SUBPATH);
  const previous = readCandidatesFile(candidatesPath);
  const firstSeen = new Map((previous?.candidates ?? []).map((c) => [c.id, c.first_seen]));
  const nowText = new Date(nowMs).toISOString();
  const candidates: ScratchPromotionCandidate[] = [];
  const held = [...plan.jobs.entries()].filter(([, job]) => job.graceUntilMs !== null);
  // A dry run never writes: without a stored salt it uses a throwaway one.
  const salt =
    held.length === 0
      ? ''
      : (loadScratchCandidateSalt({ create: !dryRun }) ?? randomBytes(32).toString('hex'));
  for (const [dir, job] of held.sort(([a], [b]) => a.localeCompare(b))) {
    if (job.graceUntilMs === null) continue;
    const described = describeCandidate(dir, job, salt);
    const deleteAfter = new Date(job.graceUntilMs).toISOString();
    candidates.push({
      ...described,
      file_count: job.fileCount,
      first_seen: firstSeen.get(described.id) ?? nowText,
      delete_after: deleteAfter,
    });
    const subject = described.dir ?? `a ${described.tier} scratch job (id ${described.id})`;
    logger.warn(
      `[JANITOR] scratch code kept past tmp TTL — ${subject} holds ${job.authored.length} unpromoted authored file(s) and will be deleted after ${deleteAfter} (code_grace_days=${plan.graceDays}) | ` +
        `promote it now: ${described.command} | evidence: ${CANDIDATES_REPO_PATH} id=${described.id}`
    );
  }
  if (!dryRun && (candidates.length > 0 || previous)) {
    const file: ScratchPromotionCandidatesFile = {
      generated_at: nowText,
      code_grace_days: plan.graceDays,
      candidates,
    };
    try {
      writeJson(candidatesPath, file);
    } catch (err) {
      logger.warn(
        `[JANITOR] scratch promotion candidates not written — ${err instanceof Error ? err.message : String(err)} | ` +
          `the grace still applies; check write access to ${CANDIDATES_REPO_PATH} | evidence: ${candidatesPath}`
      );
    }
  }
  return candidates;
}

/**
 * One-line, warn-only summary of the scratch dirs currently held in their
 * code grace window (session baseline visibility). Null when none are listed
 * or the candidates file is absent/unreadable. Never names a tier job's path.
 */
export function scratchPromotionCandidatesWarning(): string | null {
  const file = readCandidatesFile(shared(SCRATCH_PROMOTION_CANDIDATES_SUBPATH));
  const candidates = file?.candidates ?? [];
  if (candidates.length === 0) return null;
  const earliest = candidates
    .map((candidate) => candidate.delete_after)
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];
  return (
    `${candidates.length} scratch dir(s) hold unpromoted code and will be deleted after their grace` +
    (earliest ? ` (earliest ${earliest})` : '') +
    ` — promote what you need with the command listed in ${CANDIDATES_REPO_PATH}`
  );
}
