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
import { pathToFileURL } from 'node:url';
import { safeExecResult, safeExistsSync } from '../secure-io.js';
import * as pathResolver from '../path-resolver.js';
import { listMemoryPromotionCandidates, type MemoryCandidate } from './memory-promotion-queue.js';
import type { GitRunner } from './memory-promotion-git.js';
import { defaultGitRunner } from './memory-promotion-git.js';

export type { GitRunner };
export { defaultGitRunner };

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

function parseMissionId(body: string): string | undefined {
  const coordination = extractMarkdownSection(body, 'Coordination');
  if (coordination === null) return undefined;
  const match = coordination.match(/^-\s*Mission ID:\s*(.*)$/imu);
  if (!match) return undefined;
  const value = (match[1] || '').trim();
  if (!value || PLACEHOLDER_MISSION_ID_PATTERN.test(value)) return undefined;
  return value;
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

/** Parse a PR body's Coordination `Mission ID` and `## Knowledge` section lines. */
export function parsePrBodyKnowledge(body: string): ParsedPrBodyKnowledge {
  const missionId = parseMissionId(body);
  const section = extractMarkdownSection(body, 'Knowledge');
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
  gitRunner?: GitRunner;
}

const GLOBAL_PROMOTION_QUEUE_RELATIVE_PATH = 'active/shared/runtime/memory/promotion-queue.jsonl';
const MISSIONS_RELATIVE_PATH = 'active/missions';

/** True when `root` itself already has mission/queue records (no need to look elsewhere). */
function rootHasMissionRecords(root: string): boolean {
  if (safeExistsSync(path.join(root, GLOBAL_PROMOTION_QUEUE_RELATIVE_PATH))) return true;
  return safeExistsSync(path.join(root, MISSIONS_RELATIVE_PATH));
}

/**
 * Resolve where mission/memory records live: the explicit `--mission-root`,
 * else the current root if it already has them, else the repository's main
 * worktree (`git worktree list --porcelain`'s first `worktree` entry — git
 * always lists the main worktree first).
 */
export function resolveMissionRoot(input: ResolveMissionRootInput): string {
  const explicit = input.explicitRoot?.trim();
  if (explicit) return path.resolve(explicit);
  const resolvedCwdRoot = path.resolve(input.cwdRoot);
  if (rootHasMissionRecords(resolvedCwdRoot)) return resolvedCwdRoot;
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

export interface ListChangedFilesInput {
  repoRoot: string;
  /** Defaults to `origin/main`. */
  base?: string;
  gitRunner?: GitRunner;
}

/** `git diff --name-only <base>...HEAD`, repo-relative paths, no shell string. */
export function listChangedFiles(input: ListChangedFilesInput): string[] {
  const runner = input.gitRunner ?? defaultGitRunner;
  const base = input.base?.trim() || 'origin/main';
  const result = runner(['diff', '--name-only', `${base}...HEAD`], input.repoRoot);
  if (result.status !== 0) {
    throw new Error(
      `[PR_KNOWLEDGE_READINESS] git diff --name-only ${base}...HEAD failed in ${input.repoRoot} — ${(result.stderr || '').trim()} | next: fetch ${base} locally, or pass --base`
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// --- reading mission memory candidates across worktrees ------------------

/**
 * Print the mission root's memory candidates as JSON. Runs in a child node
 * process whose Kyberion root IS the mission root (`KYBERION_ROOT` below),
 * mirroring `writePromotedFilesToWorktree` (KL-05): secure-io's tier-guard
 * confines file reads to the current process's own project root, so a
 * cross-worktree read has to happen inside a process rooted at that worktree
 * rather than by reading its files in-process.
 */
function childReaderScript(coreDistDir: string): string {
  const moduleUrl = (name: string) =>
    JSON.stringify(pathToFileURL(path.join(coreDistDir, name)).href);
  return [
    `const path = await import('node:path');`,
    `const pathResolverMod = await import(${moduleUrl('path-resolver.js')});`,
    `const queue = await import(${moduleUrl('knowledge/memory-promotion-queue.js')});`,
    `let raw = '';`,
    `for await (const chunk of process.stdin) raw += chunk;`,
    `const payload = JSON.parse(raw);`,
    `if (path.resolve(pathResolverMod.rootDir()) !== path.resolve(payload.root)) {`,
    `  throw new Error('child Kyberion root ' + pathResolverMod.rootDir() + ' does not match target ' + payload.root);`,
    `}`,
    `process.stdout.write('\\n' + JSON.stringify({ ok: true, candidates: queue.listMemoryPromotionCandidates() }) + '\\n');`,
  ].join('\n');
}

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
    ['--input-type=module', '-e', childReaderScript(coreDistDir)],
    {
      cwd: root,
      env: { KYBERION_ROOT: root },
      input: JSON.stringify({ root }),
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
 * Read a mission root's memory candidates, taking the in-process fast path
 * (the existing, governed `listMemoryPromotionCandidates`) when the mission
 * root IS the current process's root and no reader was injected, and using
 * `reader` (the cross-worktree child process by default) otherwise. An
 * explicitly injected `reader` always wins, even when the roots match, so
 * callers (tests) can pin the candidate set precisely.
 */
export function readMissionMemoryCandidates(
  missionRoot: string,
  cwdRoot: string,
  reader?: MissionMemoryCandidateReader
): MemoryCandidate[] {
  const resolvedMissionRoot = path.resolve(missionRoot);
  const resolvedCwdRoot = path.resolve(cwdRoot);
  if (!reader && resolvedMissionRoot === resolvedCwdRoot) {
    return listMemoryPromotionCandidates();
  }
  return (reader ?? readMissionMemoryCandidatesFromRoot)(resolvedMissionRoot);
}

// --- readiness evaluation --------------------------------------------------

export type KnowledgeViolationCode =
  | 'missing_knowledge_section'
  | 'no_mission_candidates'
  | 'unresolved_candidate'
  | 'promoted_record_not_in_diff'
  | 'candidate_not_declared'
  | 'tier_leak';

export interface KnowledgeViolation {
  code: KnowledgeViolationCode;
  message: string;
}

export interface EvaluatePrKnowledgeReadinessInput {
  body: string;
  candidates: readonly MemoryCandidate[];
  changedFiles: readonly string[];
}

export interface EvaluatePrKnowledgeReadinessResult {
  ok: boolean;
  violations: KnowledgeViolation[];
}

const TIER_LEAK_PREFIXES = ['knowledge/confidential/', 'knowledge/personal/'];

function isTierLeakPath(filePath: string): boolean {
  const normalized = String(filePath || '')
    .trim()
    .replace(/\\/gu, '/');
  return TIER_LEAK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Product/unclassified candidates must be curated to a final state before the PR opens. */
function isUnresolvedDomain(domain: MemoryCandidate['knowledge_domain']): boolean {
  return !domain || domain === 'product' || domain === 'unclassified';
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

  if (!parsed.hasKnowledgeSection) {
    violations.push({
      code: 'missing_knowledge_section',
      message:
        'PR body has no "## Knowledge" section — add one line per mission memory candidate (promoted:/rejected:/routed:) or "none — <reason>" when there is no mission.',
    });
  }

  for (const changedFile of input.changedFiles) {
    if (isTierLeakPath(changedFile)) {
      violations.push({
        code: 'tier_leak',
        message: `Changed file '${changedFile}' is under a confidential/personal knowledge tier and must never appear in a PR diff.`,
      });
    }
  }

  if (!parsed.missionId) {
    return { ok: violations.length === 0, violations };
  }

  const missionSourceRef = `mission:${parsed.missionId}`;
  const missionCandidates = input.candidates.filter(
    (candidate) => candidate.source_ref === missionSourceRef
  );
  if (missionCandidates.length === 0) {
    violations.push({
      code: 'no_mission_candidates',
      message: `Mission ${parsed.missionId} has no memory candidates in the queue — run "mission verify" and "mission distill" before opening the PR.`,
    });
    return { ok: violations.length === 0, violations };
  }

  const declaredCandidateIds = new Set(
    parsed.knowledgeLines
      .map((line) => line.candidateId)
      .filter((candidateId): candidateId is string => Boolean(candidateId))
  );

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
      const ref = candidate.promoted_ref?.trim();
      if (!ref || !input.changedFiles.includes(ref)) {
        violations.push({
          code: 'promoted_record_not_in_diff',
          message: `Candidate ${candidate.candidate_id} is promoted but its record (${ref || '(no promoted_ref)'}) is not in this PR's diff — commit the promoted record with this PR.`,
        });
      }
    }

    if (!declaredCandidateIds.has(candidate.candidate_id)) {
      violations.push({
        code: 'candidate_not_declared',
        message: `Candidate ${candidate.candidate_id} is not mentioned in the PR body's "## Knowledge" section — add a promoted:/rejected:/routed: line for it.`,
      });
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
  const missionRoot = resolveMissionRoot({
    ...input.missionRootInput,
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
