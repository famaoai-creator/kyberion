#!/usr/bin/env node
/**
 * `pnpm kyberion pr body` — render a compliant PR body scaffold from
 * `.github/PULL_REQUEST_TEMPLATE.md` so the Coordination/Knowledge contract
 * (KL-02/KL-03, `evaluatePrKnowledgeReadiness`) is generated rather than
 * hand-authored.
 *
 * `- Mission ID:` is filled from `--mission` or by auto-detecting the single
 * nonterminal mission under the resolved mission root. `## Knowledge` lines
 * are rendered from the mission's memory candidates: promoted → `promoted:`,
 * rejected → `rejected:`, routed (organization/personal domain) → `routed:`;
 * still-pending candidates appear as HTML comments (the parser strips them,
 * so they can never masquerade as declarations). With no mission the scaffold
 * emits the required `none — <reason>` placeholder.
 *
 * Flags: --mission <ID> · --mission-root <path> (same semantics as
 * `pr create`) · --out <path> (repo-relative; default prints to stdout).
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  readMissionMemoryCandidates,
  resolveMissionRoot,
} from '@agent/core/knowledge/pr-knowledge-readiness';
import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import { defineScript, isDirectScript } from '../lib/harness.js';
import { guardCliArgsNormalized, type CliGuardSpec } from '../lib/cli/cli-guard.js';

type Print = (value: unknown) => void;

const PR_BODY_CLI: CliGuardSpec = {
  command: 'pnpm kyberion pr body',
  manifestId: 'script.pr.body',
  options: [
    { flag: '--mission', value: '<MSN-ID>' },
    { flag: '--mission-root', value: '<path>' },
    { flag: '--out', value: '<repo-relative path>' },
  ],
};

const TEMPLATE_PATH = '.github/PULL_REQUEST_TEMPLATE.md';
const MISSION_TIERS = ['public', 'confidential', 'personal'] as const;

interface BodyOptions {
  mission?: string;
  missionRoot?: string;
  out?: string;
}

function parseArgs(argv: string[]): BodyOptions {
  const options: BodyOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--mission') options.mission = argv[++i];
    else if (arg === '--mission-root') options.missionRoot = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
  }
  return options;
}

/** Nonterminal mission directories under `<root>/active/missions/<tier>/<id>` (mission-state.json present). */
function listMissionIds(root: string): string[] {
  const ids: string[] = [];
  for (const tier of MISSION_TIERS) {
    const tierDir = path.join(root, 'active', 'missions', tier);
    if (!safeExistsSync(tierDir)) continue;
    for (const entry of safeReaddir(tierDir)) {
      if (safeExistsSync(path.join(tierDir, entry, 'mission-state.json'))) ids.push(entry);
    }
  }
  return ids;
}

function knowledgeLineFor(candidate: MemoryCandidate): string | undefined {
  if (candidate.status === 'promoted')
    return `- promoted: ${candidate.candidate_id} → ${candidate.promoted_ref ?? '<path>'}`;
  if (candidate.status === 'rejected')
    return `- rejected: ${candidate.candidate_id} — ${candidate.ratification_note?.trim() || '<reason>'}`;
  if (candidate.knowledge_domain === 'organization' || candidate.knowledge_domain === 'personal')
    return `- routed: ${candidate.candidate_id} → ${candidate.knowledge_domain}`;
  return undefined;
}

/**
 * Rewrite `## Coordination` (Mission ID) and `## Knowledge` (candidate lines)
 * inside the PR template. Section detection follows the template's `## `
 * headings; the Knowledge section's guidance comment stays and its example
 * bullet block is replaced with real declarations.
 */
export function renderPrBodyScaffold(input: {
  template: string;
  missionId?: string;
  candidates: MemoryCandidate[];
}): string {
  const lines = input.template.split('\n');
  const headingAt = (index: number) => lines[index]?.match(/^##\s+/u);
  const knowledgeStart = lines.findIndex((line) => /^##\s+Knowledge\b/u.test(line));
  if (knowledgeStart < 0) throw new Error('PR template has no "## Knowledge" section.');
  const coordinationStart = lines.findIndex((line) => /^##\s+Coordination\b/u.test(line));

  if (input.missionId && coordinationStart >= 0) {
    const missionLine = lines.findIndex(
      (line, index) => index > coordinationStart && /^-\s*Mission ID:/u.test(line)
    );
    if (missionLine >= 0) lines[missionLine] = `- Mission ID: ${input.missionId}`;
  }

  const knowledgeEnd = lines.findIndex((line, index) => index > knowledgeStart && headingAt(index));
  const bullets: string[] = input.missionId
    ? (input.candidates.map(knowledgeLineFor).filter(Boolean) as string[])
    : ['- none — <reason why this PR has no mission>'];
  const pending = input.missionId
    ? input.candidates.filter((candidate) => knowledgeLineFor(candidate) === undefined)
    : [];
  const comments: string[] = pending.map(
    (candidate) =>
      `<!-- pending candidate ${candidate.candidate_id} (${candidate.status}) — resolve with mission memory-approve/memory-reject/memory-promote before pr create -->`
  );
  if (input.missionId && input.candidates.length === 0)
    comments.push(
      `<!-- mission ${input.missionId} has no memory candidates yet — run mission verify + distill, or declare "none — <reason>" -->`
    );

  const sectionBody = lines.slice(knowledgeStart + 1, knowledgeEnd < 0 ? undefined : knowledgeEnd);
  const kept = sectionBody.filter((line) => !/^- /u.test(line));
  const scaffold = [...kept, ...comments, ...bullets];
  lines.splice(
    knowledgeStart + 1,
    sectionBody.length,
    ...scaffold.filter((line, index) => !(line.trim() === '' && scaffold[index - 1]?.trim() === ''))
  );
  return lines.join('\n');
}

export async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  const guarded = guardCliArgsNormalized(argv, PR_BODY_CLI, print);
  if (guarded.handled) return;
  const options = parseArgs(guarded.argv);
  const cwdRoot = pathResolver.rootDir();

  const missionIds = listMissionIds(cwdRoot);
  const missionId =
    options.mission?.trim().toUpperCase() || (missionIds.length === 1 ? missionIds[0] : undefined);
  if (!options.mission && missionIds.length > 1)
    throw new Error(
      `Multiple missions found under active/missions (${missionIds.join(', ')}) — pass --mission <ID>.`
    );

  const missionRoot = resolveMissionRoot({
    cwdRoot,
    explicitRoot: options.missionRoot,
    missionId,
  });
  const candidates = missionId ? readMissionMemoryCandidates(missionRoot, cwdRoot) : [];

  const template = String(safeReadFile(pathResolver.rootResolve(TEMPLATE_PATH)));
  const body = renderPrBodyScaffold({ template, missionId, candidates });

  if (options.out) {
    const outPath = assertSafeRepositoryPath(options.out, { allowMissingLeaf: true });
    safeWriteFile(outPath, body);
    print(`[pr:body] wrote ${path.relative(cwdRoot, outPath)}`);
  } else {
    print(body);
  }
  if (missionId) print(`[pr:body] mission=${missionId} root=${missionRoot}`);
}

const script = defineScript({
  name: 'pr:body',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'pr_body.ts') ||
  isDirectScript(import.meta.url, 'pr_body.js')
) {
  void script();
}
