/**
 * KL-04 / KL-05: git-backed seams of the memory promotion flow.
 *
 * - `resolvePromotionTargetRoot` validates `--target-root` (a worktree of the
 *   same repository) so promoted records can land in a PR branch checkout.
 * - `writePromotedFilesToWorktree` writes into that worktree through a child
 *   process whose Kyberion root IS the worktree, so every write still passes
 *   secure-io / tier-guard (which never allow writes outside the current root).
 * - `readGitProvenance` stamps promoted records with the branch/commit they
 *   were written against.
 * - `ratifyPrReviewedMemoryCandidates` confirms at mission finish that the
 *   records of `pr_review` candidates reached origin/main.
 *
 * Git always runs through secure-io's `safeExecResult` (argv, no shell) and
 * never touches the network — fetching origin is the operator's step.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeExecResult, safeExistsSync } from '../secure-io.js';
import * as pathResolver from '../path-resolver.js';
import { nowIso } from '../foundation/time.js';
import {
  listMemoryPromotionCandidates,
  updateMemoryPromotionCandidateStatus,
  type MemoryCandidate,
} from './memory-promotion-queue.js';

export interface GitRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd`. Injectable so tests can fake repository state. */
export type GitRunner = (args: string[], cwd: string) => GitRunResult;

export const defaultGitRunner: GitRunner = (args, cwd) => {
  const result = safeExecResult('git', args, { cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

function gitText(runner: GitRunner, args: string[], cwd: string): string | undefined {
  try {
    const result = runner(args, cwd);
    if (result.status !== 0) return undefined;
    const text = result.stdout.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

export interface GitProvenance {
  source_branch?: string;
  source_commit?: string;
}

/** Branch + HEAD commit of `root`; fields are omitted when git cannot tell. */
export function readGitProvenance(
  root: string,
  gitRunner: GitRunner = defaultGitRunner
): GitProvenance {
  const branch = gitText(gitRunner, ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const commit = gitText(gitRunner, ['rev-parse', 'HEAD'], root);
  return {
    ...(branch && branch !== 'HEAD' ? { source_branch: branch } : {}),
    ...(commit ? { source_commit: commit } : {}),
  };
}

export interface PromotionTargetRoot {
  /** Absolute top-level directory of the target worktree (as reported by git). */
  root: string;
  /** True when the target is the current checkout itself. */
  sameAsCurrent: boolean;
}

/**
 * Validate `--target-root`: it must be the top level of a git worktree whose
 * common git dir equals the current checkout's (i.e. the same repository).
 */
export function resolvePromotionTargetRoot(
  targetRoot: string,
  options: { currentRoot?: string; gitRunner?: GitRunner } = {}
): PromotionTargetRoot {
  const runner = options.gitRunner || defaultGitRunner;
  const currentRoot = path.resolve(options.currentRoot || pathResolver.rootDir());
  const requested = String(targetRoot || '').trim();
  if (!requested) throw new Error('[PROMOTION_TARGET_ROOT] --target-root requires a path.');
  const requestedAbs = path.resolve(requested);
  const targetTop = gitText(runner, ['rev-parse', '--show-toplevel'], requestedAbs);
  if (!targetTop) {
    throw new Error(
      `[PROMOTION_TARGET_ROOT] target root is not a git worktree — ${requestedAbs} | next: pass the top-level path of a worktree of this repository (git worktree list)`
    );
  }
  const prefix = gitText(runner, ['rev-parse', '--show-prefix'], requestedAbs);
  if (prefix) {
    throw new Error(
      `[PROMOTION_TARGET_ROOT] target root must be a worktree top level, not a subdirectory — ${requestedAbs} is ${prefix} inside ${targetTop} | next: pass ${targetTop}`
    );
  }
  const commonDirArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const targetCommon = gitText(runner, commonDirArgs, requestedAbs);
  const currentCommon = gitText(runner, commonDirArgs, currentRoot);
  if (!targetCommon || !currentCommon) {
    throw new Error(
      `[PROMOTION_TARGET_ROOT] cannot resolve the git common dir — target=${requestedAbs} current=${currentRoot} | next: check that both checkouts are git worktrees`
    );
  }
  if (path.resolve(targetCommon) !== path.resolve(currentCommon)) {
    throw new Error(
      `[PROMOTION_TARGET_ROOT] target root belongs to a different repository — ${requestedAbs} uses ${targetCommon}, this checkout uses ${currentCommon} | next: pass a worktree of this repository (git worktree list)`
    );
  }
  const currentTop = gitText(runner, ['rev-parse', '--show-toplevel'], currentRoot);
  return {
    root: path.resolve(targetTop),
    sameAsCurrent: Boolean(currentTop) && path.resolve(currentTop!) === path.resolve(targetTop),
  };
}

export interface WorktreeFileWrite {
  /** Repo-relative path (identical in every worktree of the repository). */
  path: string;
  content: string;
}

export type WorktreeFileWriter = (input: {
  root: string;
  files: WorktreeFileWrite[];
  executionRole: string;
}) => void;

function childWriterScript(coreDistDir: string): string {
  const moduleUrl = (name: string) =>
    JSON.stringify(pathToFileURL(path.join(coreDistDir, name)).href);
  return [
    `const path = await import('node:path');`,
    `const { withExecutionContext } = await import(${moduleUrl('authority.js')});`,
    `const secureIo = await import(${moduleUrl('secure-io.js')});`,
    `const pathResolver = await import(${moduleUrl('path-resolver.js')});`,
    `let raw = '';`,
    `for await (const chunk of process.stdin) raw += chunk;`,
    `const payload = JSON.parse(raw);`,
    `if (path.resolve(pathResolver.rootDir()) !== path.resolve(payload.root)) {`,
    `  throw new Error('child Kyberion root ' + pathResolver.rootDir() + ' does not match target ' + payload.root);`,
    `}`,
    `const written = withExecutionContext(payload.role, () => payload.files.map((file) => {`,
    `  const abs = pathResolver.assertSafeRepositoryPath(pathResolver.rootResolve(file.path), { allowMissingLeaf: true });`,
    `  secureIo.safeMkdir(path.dirname(abs), { recursive: true });`,
    `  secureIo.safeWriteFile(abs, file.content);`,
    `  return file.path;`,
    `}), 'ecosystem_architect');`,
    `process.stdout.write('\\n' + JSON.stringify({ ok: true, written }) + '\\n');`,
  ].join('\n');
}

/**
 * Default writer for a sibling worktree. secure-io (tier-guard) rejects any
 * write outside the current root, so the write runs in a child node process
 * with KYBERION_ROOT = target: the same secure-io guards then apply relative
 * to the target checkout. Uses the current checkout's built @agent/core.
 */
export const writePromotedFilesToWorktree: WorktreeFileWriter = ({
  root,
  files,
  executionRole,
}) => {
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`[PROMOTION_TARGET_ROOT] refusing non repo-relative path: ${file.path}`);
    }
  }
  const coreDistDir = pathResolver.rootResolve('libs/core/dist');
  if (!safeExistsSync(path.join(coreDistDir, 'secure-io.js'))) {
    throw new Error(
      `[PROMOTION_TARGET_ROOT] built @agent/core not found — ${coreDistDir} | next: run pnpm --filter @agent/core run build, then retry`
    );
  }
  const result = safeExecResult(
    process.execPath,
    ['--input-type=module', '-e', childWriterScript(coreDistDir)],
    {
      cwd: root,
      env: { KYBERION_ROOT: root },
      input: JSON.stringify({ root, role: executionRole, files }),
      timeoutMs: 60_000,
    }
  );
  if (result.status !== 0 || !/"ok":true/u.test(result.stdout)) {
    throw new Error(
      `[PROMOTION_TARGET_ROOT] writing promoted record into ${root} failed — ${(result.stderr || result.error?.message || '').trim().slice(-1500)} | next: check the target worktree's governance policy and retry`
    );
  }
};

export const RATIFICATION_TARGET = 'origin/main';

export interface PrReviewRatificationResult {
  target: string;
  target_commit?: string;
  ratified: MemoryCandidate[];
  already_ratified: string[];
  missing: Array<{ candidate_id: string; promoted_ref: string; reason: string }>;
  /**
   * pr_review candidates of this mission that are approved but were never
   * promoted: their record never reached a PR, so finish must wait until they
   * are promoted (`memory-promote --target-root`) or rejected.
   */
  unpromoted: string[];
}

export function isMissionCandidate(candidate: MemoryCandidate, missionId: string): boolean {
  const sourceRef = String(candidate.source_ref || '').trim();
  return sourceRef === `mission:${missionId}` || sourceRef.startsWith(`mission:${missionId}:`);
}

function repoRelativeRef(ref: string | undefined): string | undefined {
  const normalized = String(ref || '')
    .trim()
    .replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    return undefined;
  }
  if (normalized.split('/').includes('..')) return undefined;
  return path.posix.normalize(normalized);
}

/**
 * KL-04: for this mission's promoted `pr_review` candidates, confirm the
 * promoted record exists on origin/main (local ref — no fetch) and record the
 * ratification. Candidates whose record is not on origin/main are returned in
 * `missing`; approved-but-never-promoted pr_review candidates are returned in
 * `unpromoted`. The caller blocks finish on either. `steward` candidates are
 * untouched.
 */
export function ratifyPrReviewedMemoryCandidates(input: {
  missionId: string;
  repoRoot?: string;
  gitRunner?: GitRunner;
  now?: () => string;
}): PrReviewRatificationResult {
  const missionId = String(input.missionId || '')
    .trim()
    .toUpperCase();
  const runner = input.gitRunner || defaultGitRunner;
  const repoRoot = input.repoRoot || pathResolver.rootDir();
  const result: PrReviewRatificationResult = {
    target: RATIFICATION_TARGET,
    ratified: [],
    already_ratified: [],
    missing: [],
    unpromoted: [],
  };
  const prReviewed = listMemoryPromotionCandidates().filter(
    (candidate) =>
      isMissionCandidate(candidate, missionId) && candidate.approval_channel === 'pr_review'
  );
  result.unpromoted = prReviewed
    .filter((candidate) => candidate.status === 'approved')
    .map((candidate) => candidate.candidate_id);
  const candidates = prReviewed.filter((candidate) => candidate.status === 'promoted');
  if (candidates.length === 0) return result;
  const pending = candidates.filter((candidate) => {
    if (candidate.ratified_commit) {
      result.already_ratified.push(candidate.candidate_id);
      return false;
    }
    return true;
  });
  if (pending.length === 0) return result;

  const targetCommit = gitText(
    runner,
    ['rev-parse', '--verify', '--quiet', `${RATIFICATION_TARGET}^{commit}`],
    repoRoot
  );
  if (!targetCommit) {
    for (const candidate of pending) {
      result.missing.push({
        candidate_id: candidate.candidate_id,
        promoted_ref: candidate.promoted_ref || '',
        reason: `${RATIFICATION_TARGET} is not available locally`,
      });
    }
    return result;
  }
  result.target_commit = targetCommit;
  const ratifiedAt = (input.now || nowIso)();
  for (const candidate of pending) {
    const ref = repoRelativeRef(candidate.promoted_ref);
    if (!ref) {
      result.missing.push({
        candidate_id: candidate.candidate_id,
        promoted_ref: candidate.promoted_ref || '',
        reason: 'promoted_ref is not a repo-relative path',
      });
      continue;
    }
    let exists = false;
    try {
      exists = runner(['cat-file', '-e', `${targetCommit}:${ref}`], repoRoot).status === 0;
    } catch {
      exists = false;
    }
    if (!exists) {
      result.missing.push({
        candidate_id: candidate.candidate_id,
        promoted_ref: ref,
        reason: `not present at ${RATIFICATION_TARGET} (${targetCommit.slice(0, 12)})`,
      });
      continue;
    }
    const updated = updateMemoryPromotionCandidateStatus({
      candidateId: candidate.candidate_id,
      status: candidate.status,
      ...(candidate.scope ? { scope: candidate.scope } : {}),
      ratification: {
        ratifiedAt,
        ratifiedCommit: targetCommit,
        ratificationTarget: RATIFICATION_TARGET,
      },
    });
    if (updated) result.ratified.push(updated);
  }
  return result;
}
