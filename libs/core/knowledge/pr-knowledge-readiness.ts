/**
 * KL-03: local, blocking Knowledge readiness check for `pr create`.
 *
 * A PR that carries a mission's memory candidates must show, in its body,
 * what became of each one (promoted/rejected/routed) before `gh pr create`
 * ever runs — see docs/developer/improvement-plans-2026-09/KNOWLEDGE_IN_PR_PLAN_2026-09-30.ja.md
 * (KL-02/KL-03). This module is pure evaluation logic plus the small,
 * secure-io-backed seams needed to gather its inputs (git diff, git worktree
 * list, and — when the mission was recorded in a different worktree than the
 * one `pr create` runs from — the mission memory queue of that worktree).
 *
 * CI never runs this check: `active/` mission records are gitignored and do
 * not exist in a CI checkout, so this is a local `pr create` gate only.
 */
import * as path from 'node:path';
import { safeExecResult, safeExistsSync, safeReadFile, safeReaddir } from '../secure-io.js';
import * as pathResolver from '../path-resolver.js';
import { PHYSICAL_TENANT_NAMESPACE } from '../physical-namespace.js';
import { listMemoryPromotionCandidates, type MemoryCandidate } from './memory-promotion-queue.js';
import type { GitRunner } from './memory-promotion-git.js';
import { coreDistDirUrl, defaultGitRunner } from './memory-promotion-git.js';

export type { GitRunner };
export { defaultGitRunner };

/** Repo-relative path normalization shared by diff parsing and declared-path comparisons: backslashes → `/`, strip leading `./`. */
function normalizeRepoPath(rawPath: string | undefined): string {
  let normalized = String(rawPath || '')
    .trim()
    .replace(/\\/gu, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

// --- PR body parsing --------------------------------------------------

export type KnowledgeLineKind = 'promoted' | 'rejected' | 'routed' | 'none';

export interface KnowledgeLine {
  kind: KnowledgeLineKind;
  candidateId?: string;
  /** `promoted` only: the record path the candidate id maps to. */
  path?: string;
  /** `routed` only. */
  domain?: 'organization' | 'personal';
  /** `rejected` / `none` only. */
  reason?: string;
  raw: string;
}

export interface ParsedPrBodyKnowledge {
  missionId?: string;
  knowledgeLines: KnowledgeLine[];
  hasKnowledgeSection: boolean;
}

const PLACEHOLDER_MISSION_ID_PATTERN = /^(n\/a|tbd|none|-|_+|<.*>)$/i;

/** Strip Markdown/HTML comments (including multi-line ones) before parsing — a comment is never a declaration. */
function stripHtmlComments(text: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<!--', cursor);
    if (open === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, open);
    const close = text.indexOf('-->', open + 4);
    // An unterminated comment hides everything after it — never a declaration.
    if (close === -1) break;
    cursor = close + 3;
  }
  return out;
}

/** Slice a `## Heading` section's body out of a Markdown document (case-insensitive heading match). */
function extractMarkdownSection(body: string, heading: string): string | null {
  const lines = String(body || '').split(/\r?\n/);
  const headingPattern = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, 'iu');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (headingPattern.test(lines[index]!.trim())) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/u.test(lines[index]!.trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Strip surrounding backticks/quotes/whitespace a human might wrap a Mission ID in (e.g. `` `MSN-X` ``). */
function stripMissionIdDecoration(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^[`'"]+/u, '')
    .replace(/[`'"]+$/u, '')
    .trim();
}

/** `sanitizedBody` must already have HTML comments stripped (see `parsePrBodyKnowledge`). */
function parseMissionId(sanitizedBody: string): string | undefined {
  const coordination = extractMarkdownSection(sanitizedBody, 'Coordination');
  if (coordination === null) return undefined;
  const match = coordination.match(/^-[ \t]*Mission ID:[ \t]*(.*)$/imu);
  if (!match) return undefined;
  const stripped = stripMissionIdDecoration(match[1] || '');
  if (!stripped || PLACEHOLDER_MISSION_ID_PATTERN.test(stripped)) return undefined;
  // Normalized once here so every downstream comparison (mission root
  // resolution, candidate source_ref matching) works off the same casing.
  return stripped.toUpperCase();
}

const KNOWLEDGE_LINE_PATTERNS: ReadonlyArray<{
  kind: KnowledgeLineKind;
  pattern: RegExp;
}> = [
  { kind: 'promoted', pattern: /^promoted:\s*(\S+)\s*(?:→|->)\s*(.+)$/iu },
  { kind: 'routed', pattern: /^routed:\s*(\S+)\s*(?:→|->)\s*(organization|personal)\s*$/iu },
  { kind: 'rejected', pattern: /^rejected:\s*(\S+)\s*(?:—|--)\s*(.+)$/iu },
  { kind: 'none', pattern: /^none\s*(?:—|--)\s*(.+)$/iu },
];

function parseKnowledgeLine(rawLine: string): KnowledgeLine | null {
  const stripped = rawLine
    .trim()
    .replace(/^[-*]\s+/u, '')
    .trim();
  if (!stripped || stripped.startsWith('<!--')) return null;
  // The template ships literal `<candidate_id>` / `<path>` / `<reason>`
  // placeholders; an unedited placeholder line must not be mistaken for a
  // real declaration.
  if (/<[a-z_]+>/iu.test(stripped)) return null;
  for (const { kind, pattern } of KNOWLEDGE_LINE_PATTERNS) {
    const match = stripped.match(pattern);
    if (!match) continue;
    if (kind === 'promoted') {
      return { kind, candidateId: match[1], path: (match[2] || '').trim(), raw: rawLine };
    }
    if (kind === 'routed') {
      return {
        kind,
        candidateId: match[1],
        domain: (match[2] || '').toLowerCase() as 'organization' | 'personal',
        raw: rawLine,
      };
    }
    if (kind === 'rejected') {
      return { kind, candidateId: match[1], reason: (match[2] || '').trim(), raw: rawLine };
    }
    return { kind: 'none', reason: (match[1] || '').trim(), raw: rawLine };
  }
  return null;
}

/** Parse a PR body's Coordination `Mission ID` and `## Knowledge` section lines. HTML comments are stripped first, so a comment can never masquerade as a declaration. */
export function parsePrBodyKnowledge(body: string): ParsedPrBodyKnowledge {
  const sanitized = stripHtmlComments(String(body || ''));
  const missionId = parseMissionId(sanitized);
  const section = extractMarkdownSection(sanitized, 'Knowledge');
  const hasKnowledgeSection = section !== null;
  const knowledgeLines: KnowledgeLine[] = [];
  if (section) {
    for (const rawLine of section.split(/\r?\n/)) {
      const parsed = parseKnowledgeLine(rawLine);
      if (parsed) knowledgeLines.push(parsed);
    }
  }
  return { missionId, knowledgeLines, hasKnowledgeSection };
}

// --- mission root resolution -------------------------------------------

export interface ResolveMissionRootInput {
  /** `--mission-root`; wins outright when given. */
  explicitRoot?: string;
  /** The current process's project root (where `pr create` runs). */
  cwdRoot: string;
  /** The PR body's parsed Mission ID, when there is one — lets resolution prefer the root that actually has this mission's records over one that merely has *some* mission's records. */
  missionId?: string;
  gitRunner?: GitRunner;
}

const GLOBAL_PROMOTION_QUEUE_RELATIVE_PATH = 'active/shared/runtime/memory/promotion-queue.jsonl';
const MISSIONS_RELATIVE_PATH = 'active/missions';
const ARCHIVE_MISSIONS_RELATIVE_PATH = 'active/archive/missions';
/** Mirrors `memory-promotion-queue.ts`'s own tenant queue layout (`physicalScopedPath('active/shared/runtime', {tenant_slug, scope_kind:'tenant'}, 'memory', 'promotion-queue.jsonl')` — see `physical-namespace.ts`). */
const TENANT_RUNTIME_RELATIVE_PATH = path.posix.join(
  'active/shared/runtime',
  PHYSICAL_TENANT_NAMESPACE
);

/** True when `root` itself already has mission/queue records (no need to look elsewhere). Only used when no Mission ID was parsed to check against. */
function rootHasMissionRecords(root: string): boolean {
  if (safeExistsSync(path.join(root, GLOBAL_PROMOTION_QUEUE_RELATIVE_PATH))) return true;
  return safeExistsSync(path.join(root, MISSIONS_RELATIVE_PATH));
}

/**
 * Enumerate every tenant-scoped memory promotion queue file under `root`
 * (`active/shared/runtime/tenants/<slug>/memory/promotion-queue.jsonl`).
 * Organization/personal-domain candidates live here rather than in the
 * global queue — see `memory-promotion-queue.ts`'s `queuePathsForAllScopes`,
 * which this mirrors for the case where `root` is a foreign worktree (not
 * the current process's own root, so its API can't be called in-process). A
 * missing/unreadable tenants dir just means "no tenant queues" rather than
 * an error — a foreign worktree's tenant runtime state must never abort a
 * readiness check.
 */
function listTenantPromotionQueuePaths(root: string): string[] {
  const tenantsDir = path.join(root, TENANT_RUNTIME_RELATIVE_PATH);
  if (!safeExistsSync(tenantsDir)) return [];
  let tenantSlugs: string[] = [];
  try {
    tenantSlugs = safeReaddir(tenantsDir);
  } catch {
    return [];
  }
  const queuePaths: string[] = [];
  for (const slug of tenantSlugs) {
    const queuePath = path.join(tenantsDir, slug, 'memory', 'promotion-queue.jsonl');
    if (safeExistsSync(queuePath)) queuePaths.push(queuePath);
  }
  return queuePaths;
}

/** True when a memory promotion queue file mentions a candidate whose `source_ref` is this mission (`mission:<ID>` or `mission:<ID>:...`), matched case-insensitively on the ID. */
function queueFileHasMissionCandidateRecord(queuePath: string, idLower: string): boolean {
  if (!safeExistsSync(queuePath)) return false;
  let raw = '';
  try {
    raw = String(
      safeReadFile(queuePath, { encoding: 'utf8', label: 'memory promotion queue' }) || ''
    );
  } catch {
    return false;
  }
  const haystack = raw.toLowerCase();
  return (
    haystack.includes(`"source_ref":"mission:${idLower}"`) ||
    haystack.includes(`"source_ref":"mission:${idLower}:`) ||
    haystack.includes(`"source_ref": "mission:${idLower}"`) ||
    haystack.includes(`"source_ref": "mission:${idLower}:`)
  );
}

/** True when `root`'s global OR any tenant-scoped memory promotion queue file mentions a candidate whose `source_ref` names this mission. */
function rootHasMissionCandidateRecords(root: string, missionId: string): boolean {
  const idLower = missionId.toLowerCase();
  const queuePaths = [
    path.join(root, GLOBAL_PROMOTION_QUEUE_RELATIVE_PATH),
    ...listTenantPromotionQueuePaths(root),
  ];
  return queuePaths.some((queuePath) => queueFileHasMissionCandidateRecord(queuePath, idLower));
}

/**
 * True when `root` actually contains this specific mission's records: a
 * mission directory (`active/missions/<tier>/<ID>` or
 * `active/archive/missions/<ID>`), or a memory-promotion-queue candidate
 * whose `source_ref` names this mission.
 */
function rootHasMission(root: string, missionId: string): boolean {
  if (!missionId) return false;
  if (safeExistsSync(path.join(root, ARCHIVE_MISSIONS_RELATIVE_PATH, missionId))) return true;
  const missionsDir = path.join(root, MISSIONS_RELATIVE_PATH);
  if (safeExistsSync(missionsDir)) {
    let tiers: string[] = [];
    try {
      tiers = safeReaddir(missionsDir);
    } catch {
      tiers = [];
    }
    if (tiers.some((tier) => safeExistsSync(path.join(missionsDir, tier, missionId)))) return true;
  }
  return rootHasMissionCandidateRecords(root, missionId);
}

/**
 * Resolve where mission/memory records live: the explicit `--mission-root`,
 * else the current root when it already has THIS mission's records (falling
 * back to "has any mission records at all" only when no Mission ID was
 * parsed), else the repository's main worktree (`git worktree list
 * --porcelain`'s first `worktree` entry — git always lists the main worktree
 * first).
 */
export function resolveMissionRoot(input: ResolveMissionRootInput): string {
  const explicit = input.explicitRoot?.trim();
  if (explicit) return path.resolve(explicit);
  const resolvedCwdRoot = path.resolve(input.cwdRoot);
  const missionId = input.missionId?.trim().toUpperCase() || undefined;
  const cwdHasWhatWeNeed = missionId
    ? rootHasMission(resolvedCwdRoot, missionId)
    : rootHasMissionRecords(resolvedCwdRoot);
  if (cwdHasWhatWeNeed) return resolvedCwdRoot;
  const runner = input.gitRunner ?? defaultGitRunner;
  let stdout = '';
  try {
    stdout = runner(['worktree', 'list', '--porcelain'], resolvedCwdRoot).stdout;
  } catch {
    return resolvedCwdRoot;
  }
  const firstWorktreeLine = stdout.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  const candidate = firstWorktreeLine?.slice('worktree '.length).trim();
  return candidate ? path.resolve(candidate) : resolvedCwdRoot;
}

// --- changed-file listing ------------------------------------------------

/** A strict git ref-name check: no leading `-` (blocks a `--base`/`--mission-root` value from being read as a git option) and only characters that are ever legal in a branch/ref name. */
export const GIT_REF_NAME_PATTERN = /^(?!-)[A-Za-z0-9._/-]+$/u;

export interface ChangedFile {
  /** git status letter for the entry (`A`, `M`, `D`, `C`, `T`, `U`, …). Renames are disabled (`--no-renames`), so a rename shows as a `D` + `A` pair. */
  status: string;
  /** Repo-relative path, forward slashes, no leading `./`. */
  path: string;
}

export interface ListChangedFilesInput {
  repoRoot: string;
  /** Defaults to `origin/main`. Must be a plain ref name (see `GIT_REF_NAME_PATTERN`); callers that accept a bare branch name from a user (e.g. `publish_pull_request.ts`) should map it to `origin/<base>` before calling this. */
  base?: string;
  gitRunner?: GitRunner;
}

/**
 * `git -c core.quotePath=false diff --name-status -z --no-renames <base>...HEAD`,
 * NUL-split so parsing never depends on shell/locale quoting.
 * `core.quotePath=false` stops git from C-quoting non-ASCII paths (e.g.
 * `"knowledge/personal/\343..."`), which would otherwise defeat prefix
 * checks like the tier-leak rule below. `--end-of-options` plus the strict
 * `GIT_REF_NAME_PATTERN` check on `base` stop a crafted base value from being
 * read as a git option.
 */
export function listChangedFiles(input: ListChangedFilesInput): ChangedFile[] {
  const runner = input.gitRunner ?? defaultGitRunner;
  const base = input.base?.trim() || 'origin/main';
  if (!GIT_REF_NAME_PATTERN.test(base)) {
    throw new Error(
      `[PR_KNOWLEDGE_READINESS] refusing unsafe diff base '${base}' | next: pass a plain branch/ref name via --base (no leading '-')`
    );
  }
  const result = runner(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      '--end-of-options',
      `${base}...HEAD`,
    ],
    input.repoRoot
  );
  if (result.status !== 0) {
    throw new Error(
      `[PR_KNOWLEDGE_READINESS] git diff --name-status ${base}...HEAD failed in ${input.repoRoot} — ${(result.stderr || '').trim()} | next: fetch ${base} locally, or pass --base`
    );
  }
  // With -z, both the status/path separator and the record terminator are NUL.
  const fields = result.stdout.split('\0').filter((field) => field.length > 0);
  const changedFiles: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    changedFiles.push({
      status: (fields[index] || '').trim(),
      path: normalizeRepoPath(fields[index + 1]),
    });
  }
  return changedFiles;
}

// --- reading mission memory candidates across worktrees ------------------

/**
 * Print the mission root's memory candidates as JSON. Runs in a child node
 * process whose Kyberion root IS the mission root (`KYBERION_ROOT` below),
 * mirroring `writePromotedFilesToWorktree` (KL-05): `listMemoryPromotionCandidates`
 * resolves its queue paths relative to the CURRENT process's own root
 * (`pathResolver.rootResolve`), so a cross-worktree read has to happen
 * inside a process rooted at that worktree rather than by calling it
 * in-process with a foreign root. `queue.listMemoryPromotionCandidates()`
 * (no scope argument) already discovers and merges every tenant-scoped
 * queue under that root itself (`active/shared/runtime/tenants/<slug>/memory/promotion-queue.jsonl`),
 * so this script needs no extra tenant list — no caller data beyond `payload`
 * flows into it, keeping it a constant string (argv injection guard).
 */
const CHILD_READER_SCRIPT = [
  `const path = await import('node:path');`,
  `let raw = '';`,
  `for await (const chunk of process.stdin) raw += chunk;`,
  `const payload = JSON.parse(raw);`,
  `const mod = (name) => import(new URL(name, payload.coreDistUrl).href);`,
  `const pathResolverMod = await mod('path-resolver.js');`,
  `const queue = await mod('knowledge/memory-promotion-queue.js');`,
  `if (path.resolve(pathResolverMod.rootDir()) !== path.resolve(payload.root)) {`,
  `  throw new Error('child Kyberion root ' + pathResolverMod.rootDir() + ' does not match target ' + payload.root);`,
  `}`,
  `process.stdout.write('\\n' + JSON.stringify({ ok: true, candidates: queue.listMemoryPromotionCandidates() }) + '\\n');`,
].join('\n');

/** Injectable seam: reads a mission root's memory candidates from outside the current process root. */
export type MissionMemoryCandidateReader = (root: string) => MemoryCandidate[];

/**
 * Default cross-worktree reader (KL-03). Uses the current checkout's built
 * `@agent/core` in a child process rooted at `root`, then parses its
 * stdout — every file read still goes through secure-io, just in the process
 * whose root is actually `root`.
 */
export const readMissionMemoryCandidatesFromRoot: MissionMemoryCandidateReader = (root) => {
  const coreDistDir = pathResolver.rootResolve('libs/core/dist');
  if (!safeExistsSync(path.join(coreDistDir, 'secure-io.js'))) {
    throw new Error(
      `[PR_KNOWLEDGE_READINESS] built @agent/core not found — ${coreDistDir} | next: run pnpm --filter @agent/core run build, then retry`
    );
  }
  const result = safeExecResult(
    process.execPath,
    ['--input-type=module', '-e', CHILD_READER_SCRIPT],
    {
      cwd: root,
      env: { KYBERION_ROOT: root },
      input: JSON.stringify({ root, coreDistUrl: coreDistDirUrl(coreDistDir) }),
      timeoutMs: 60_000,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `[PR_KNOWLEDGE_READINESS] reading mission memory candidates from ${root} failed — ${(result.stderr || result.error?.message || '').trim().slice(-1500)} | next: check --mission-root and the target worktree's governance policy`
    );
  }
  const match = result.stdout.match(/\{"ok":true[\s\S]*\}/u);
  if (!match) {
    throw new Error(
      `[PR_KNOWLEDGE_READINESS] unexpected mission memory reader output from ${root} | evidence: ${result.stdout.slice(-500)}`
    );
  }
  const parsed = JSON.parse(match[0]) as { ok: boolean; candidates?: MemoryCandidate[] };
  return parsed.candidates || [];
};

/**
 * De-duplicate by `candidate_id`, keeping the first occurrence. Returns the
 * original array (same reference) when there is nothing to drop, so callers
 * that pin an exact array (tests injecting a reader) keep seeing that same
 * reference. A global-vs-tenant-queue candidate should never collide in
 * practice, but a mission/candidate reader that merges multiple queue files
 * (global + every tenant) must not surface the same candidate twice if it
 * ever does.
 */
function dedupeCandidatesById(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const candidate of candidates) {
    if (seen.has(candidate.candidate_id)) {
      hasDuplicate = true;
      break;
    }
    seen.add(candidate.candidate_id);
  }
  if (!hasDuplicate) return candidates;
  const deduped: MemoryCandidate[] = [];
  const kept = new Set<string>();
  for (const candidate of candidates) {
    if (kept.has(candidate.candidate_id)) continue;
    kept.add(candidate.candidate_id);
    deduped.push(candidate);
  }
  return deduped;
}

/**
 * Read a mission root's memory candidates, taking the in-process fast path
 * (the existing, governed `listMemoryPromotionCandidates`) when the mission
 * root IS the current process's root and no reader was injected, and using
 * `reader` (the cross-worktree child process by default) otherwise. An
 * explicitly injected `reader` always wins, even when the roots match, so
 * callers (tests) can pin the candidate set precisely. Both paths already
 * include tenant-scoped candidates (`listMemoryPromotionCandidates()` with
 * no scope argument merges the global queue with every tenant queue under
 * the target root — see `memory-promotion-queue.ts`'s `queuePathsForAllScopes`);
 * the result is de-duplicated by `candidate_id` as a defensive measure.
 */
export function readMissionMemoryCandidates(
  missionRoot: string,
  cwdRoot: string,
  reader?: MissionMemoryCandidateReader
): MemoryCandidate[] {
  const resolvedMissionRoot = path.resolve(missionRoot);
  const resolvedCwdRoot = path.resolve(cwdRoot);
  if (!reader && resolvedMissionRoot === resolvedCwdRoot) {
    return dedupeCandidatesById(listMemoryPromotionCandidates());
  }
  return dedupeCandidatesById((reader ?? readMissionMemoryCandidatesFromRoot)(resolvedMissionRoot));
}

// --- readiness evaluation --------------------------------------------------

export type KnowledgeViolationCode =
  | 'missing_knowledge_section'
  | 'knowledge_section_empty'
  | 'no_mission_candidates'
  | 'unresolved_candidate'
  | 'promoted_record_not_in_diff'
  | 'candidate_not_declared'
  | 'declaration_mismatch'
  | 'tier_leak';

export interface KnowledgeViolation {
  code: KnowledgeViolationCode;
  message: string;
}

export interface EvaluatePrKnowledgeReadinessInput {
  body: string;
  candidates: readonly MemoryCandidate[];
  changedFiles: readonly ChangedFile[];
}

export interface EvaluatePrKnowledgeReadinessResult {
  ok: boolean;
  violations: KnowledgeViolation[];
}

const TIER_LEAK_PREFIXES = ['knowledge/confidential/', 'knowledge/personal/'];

/** Case-insensitive, `./`/backslash-normalized prefix check — a C-quoted or backslash path must not slip past this. */
function isTierLeakPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath).toLowerCase();
  return TIER_LEAK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Product/unclassified candidates must be curated to a final state before the PR opens. */
function isUnresolvedDomain(domain: MemoryCandidate['knowledge_domain']): boolean {
  return !domain || domain === 'product' || domain === 'unclassified';
}

/** Same predicate `ratifyPrReviewedMemoryCandidates` (memory-promotion-git.ts) uses to attribute a candidate to a mission, but case-insensitive on the ID so a PR body's casing of `Mission ID:` never causes a false miss. `missionId` must already be normalized (trim + uppercase). */
function isMissionCandidateSourceRef(sourceRef: string | undefined, missionId: string): boolean {
  const ref = String(sourceRef || '').trim();
  const prefix = 'mission:';
  if (!ref.toLowerCase().startsWith(prefix)) return false;
  const afterPrefix = ref.slice(prefix.length);
  const refMissionId = (afterPrefix.split(':')[0] || '').trim().toUpperCase();
  return refMissionId === missionId;
}

/** What kind of Knowledge-section line a candidate's current state requires; `undefined` when it is not yet in a final state (see `unresolved_candidate`). */
function expectedKnowledgeLineKind(candidate: MemoryCandidate): KnowledgeLineKind | undefined {
  if (candidate.status === 'rejected') return 'rejected';
  if (candidate.knowledge_domain === 'organization' || candidate.knowledge_domain === 'personal') {
    return 'routed';
  }
  if (candidate.status === 'promoted') return 'promoted';
  return undefined;
}

/**
 * Evaluate whether a PR body + its mission's memory candidates + its diff
 * satisfy the Knowledge-in-PR contract (KL-02/KL-03). Pure function: callers
 * gather `candidates` (via `readMissionMemoryCandidates`) and `changedFiles`
 * (via `listChangedFiles`) beforehand.
 */
export function evaluatePrKnowledgeReadiness(
  input: EvaluatePrKnowledgeReadinessInput
): EvaluatePrKnowledgeReadinessResult {
  const parsed = parsePrBodyKnowledge(input.body);
  const violations: KnowledgeViolation[] = [];
  let knowledgeSectionEmptyFlagged = false;

  if (!parsed.hasKnowledgeSection) {
    violations.push({
      code: 'missing_knowledge_section',
      message:
        'PR body has no "## Knowledge" section — add one line per mission memory candidate (promoted:/rejected:/routed:) or "none — <reason>" when there is no mission.',
    });
  } else if (parsed.knowledgeLines.length === 0) {
    violations.push({
      code: 'knowledge_section_empty',
      message:
        'PR body\'s "## Knowledge" section has no parseable line — declare at least one promoted:/rejected:/routed: line, or "none — <reason>" when there is no mission (an unedited template placeholder does not count).',
    });
    knowledgeSectionEmptyFlagged = true;
  }

  for (const changedFile of input.changedFiles) {
    if (changedFile.status === 'A' && isTierLeakPath(changedFile.path)) {
      violations.push({
        code: 'tier_leak',
        message: `Added file '${changedFile.path}' is under a confidential/personal knowledge tier and must never be newly added in a PR diff.`,
      });
    }
  }

  if (!parsed.missionId) {
    if (parsed.hasKnowledgeSection && !knowledgeSectionEmptyFlagged) {
      const noneLine = parsed.knowledgeLines.find((line) => line.kind === 'none');
      if (!noneLine || !(noneLine.reason || '').trim()) {
        violations.push({
          code: 'knowledge_section_empty',
          message:
            'No-mission PR must declare "none — <reason>" with a non-empty reason in the "## Knowledge" section.',
        });
      }
    }
    return { ok: violations.length === 0, violations };
  }

  const missionCandidates = input.candidates.filter((candidate) =>
    isMissionCandidateSourceRef(candidate.source_ref, parsed.missionId!)
  );
  if (missionCandidates.length === 0) {
    violations.push({
      code: 'no_mission_candidates',
      message: `Mission ${parsed.missionId} has no memory candidates in the queue — run "mission verify" and "mission distill" before opening the PR, or pass --mission-root if this mission's records live in a different worktree.`,
    });
    return { ok: violations.length === 0, violations };
  }

  for (const candidate of missionCandidates) {
    if (
      isUnresolvedDomain(candidate.knowledge_domain) &&
      (candidate.status === 'queued' || candidate.status === 'approved')
    ) {
      violations.push({
        code: 'unresolved_candidate',
        message: `Candidate ${candidate.candidate_id} is still "${candidate.status}" — curate/approve it with --approval-channel pr_review then memory-promote --target-root <this worktree>, or memory-reject it, before opening the PR.`,
      });
    }

    if (candidate.knowledge_domain === 'product' && candidate.status === 'promoted') {
      const ref = normalizeRepoPath(candidate.promoted_ref);
      const recordInDiff = ref
        ? input.changedFiles.some(
            (file) => file.path === ref && (file.status === 'A' || file.status === 'M')
          )
        : false;
      if (!ref || !recordInDiff) {
        violations.push({
          code: 'promoted_record_not_in_diff',
          message: `Candidate ${candidate.candidate_id} is promoted but its record (${ref || '(no promoted_ref)'}) is not in this PR's diff — commit the promoted record with this PR.`,
        });
      } else if (ref.endsWith('.md')) {
        const jsonRef = `${ref.slice(0, -3)}.json`;
        const jsonInDiff = input.changedFiles.some(
          (file) => file.path === jsonRef && (file.status === 'A' || file.status === 'M')
        );
        if (!jsonInDiff) {
          violations.push({
            code: 'promoted_record_not_in_diff',
            message: `Candidate ${candidate.candidate_id}'s promoted record's companion metadata file (${jsonRef}) is not added/modified in this PR's diff — commit it together with the record.`,
          });
        }
      }
    }

    const declaredLines = parsed.knowledgeLines.filter(
      (line) => line.candidateId === candidate.candidate_id
    );
    if (declaredLines.length === 0) {
      violations.push({
        code: 'candidate_not_declared',
        message: `Candidate ${candidate.candidate_id} is not mentioned in the PR body's "## Knowledge" section — add a promoted:/rejected:/routed: line for it.`,
      });
      continue;
    }

    const expectedKind = expectedKnowledgeLineKind(candidate);
    if (!expectedKind) continue;
    const matching = declaredLines.find((line) => line.kind === expectedKind);
    if (!matching) {
      violations.push({
        code: 'declaration_mismatch',
        message: `Candidate ${candidate.candidate_id} is ${candidate.status}${candidate.knowledge_domain ? ` (${candidate.knowledge_domain})` : ''} but its PR body line says "${declaredLines[0]!.kind}:" — expected "${expectedKind}:".`,
      });
    } else if (expectedKind === 'promoted') {
      const expectedPath = normalizeRepoPath(candidate.promoted_ref);
      const declaredPath = normalizeRepoPath(matching.path);
      if (!expectedPath || declaredPath !== expectedPath) {
        violations.push({
          code: 'declaration_mismatch',
          message: `Candidate ${candidate.candidate_id}'s "promoted:" line path (${matching.path || '(empty)'}) does not match its promoted_ref (${candidate.promoted_ref || '(none)'}).`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

export interface PrKnowledgeReadinessGateInput {
  body: string;
  repoRoot: string;
  missionRootInput: ResolveMissionRootInput;
  base?: string;
  gitRunner?: GitRunner;
  candidateReader?: MissionMemoryCandidateReader;
}

/**
 * End-to-end convenience for CLI wiring: resolves the mission root, reads its
 * candidates, lists this checkout's changed files against `base`, and
 * evaluates readiness. Split out from `evaluatePrKnowledgeReadiness` so tests
 * can exercise pure evaluation without gathering real git/file state.
 */
export function checkPrKnowledgeReadiness(
  input: PrKnowledgeReadinessGateInput
): EvaluatePrKnowledgeReadinessResult {
  // Parsed once here (in addition to inside evaluatePrKnowledgeReadiness) so
  // mission-root resolution can prefer the root that actually has THIS
  // mission's records (see resolveMissionRoot).
  const missionId = parsePrBodyKnowledge(input.body).missionId;
  const missionRoot = resolveMissionRoot({
    ...input.missionRootInput,
    missionId,
    gitRunner: input.missionRootInput.gitRunner ?? input.gitRunner,
  });
  const candidates = readMissionMemoryCandidates(
    missionRoot,
    input.repoRoot,
    input.candidateReader
  );
  const changedFiles = listChangedFiles({
    repoRoot: input.repoRoot,
    base: input.base,
    gitRunner: input.gitRunner,
  });
  return evaluatePrKnowledgeReadiness({ body: input.body, candidates, changedFiles });
}
