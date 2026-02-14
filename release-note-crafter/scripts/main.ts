/**
 * TypeScript version of the release-note-crafter skill.
 *
 * Parses git commit log lines, classifies them by conventional commit type,
 * and generates a structured Markdown release note.
 *
 * The CLI entry point remains in main.cjs; this module exports
 * typed helper functions for the core logic.
 *
 * Usage:
 *   import { classifyCommit, stripPrefix, generateReleaseNotes } from './main.js';
 *   const result = generateReleaseNotes(commits, '2024-01-01');
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed git commit. */
export interface Commit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/** Conventional-commit section names used for grouping. */
export type SectionName =
  | 'Features'
  | 'Bug Fixes'
  | 'Performance'
  | 'Refactoring'
  | 'Documentation'
  | 'Tests'
  | 'CI'
  | 'Build'
  | 'Style'
  | 'Chores'
  | 'Other';

/** Map of section name to commit count. */
export type SectionCounts = Partial<Record<SectionName, number>>;

/** Result of release note generation. */
export interface ReleaseNoteResult {
  commits: number;
  sections: SectionCounts;
  markdown: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered list of sections for rendering. */
export const SECTION_ORDER: SectionName[] = [
  'Features',
  'Bug Fixes',
  'Performance',
  'Refactoring',
  'Documentation',
  'Tests',
  'CI',
  'Build',
  'Style',
  'Chores',
  'Other',
];

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Map a conventional commit prefix to a section name.
 *
 * @param subject - The commit subject line
 * @returns Section name
 */
export function classifyCommit(subject: string): SectionName {
  const lower = subject.toLowerCase();
  if (/^feat[\s(:!]/.test(lower) || lower.startsWith('feat:')) return 'Features';
  if (/^fix[\s(:!]/.test(lower) || lower.startsWith('fix:')) return 'Bug Fixes';
  if (/^refactor[\s(:!]/.test(lower) || lower.startsWith('refactor:')) return 'Refactoring';
  if (/^docs[\s(:!]/.test(lower) || lower.startsWith('docs:')) return 'Documentation';
  if (/^test[\s(:!]/.test(lower) || lower.startsWith('test:')) return 'Tests';
  if (/^chore[\s(:!]/.test(lower) || lower.startsWith('chore:')) return 'Chores';
  if (/^perf[\s(:!]/.test(lower) || lower.startsWith('perf:')) return 'Performance';
  if (/^ci[\s(:!]/.test(lower) || lower.startsWith('ci:')) return 'CI';
  if (/^style[\s(:!]/.test(lower) || lower.startsWith('style:')) return 'Style';
  if (/^build[\s(:!]/.test(lower) || lower.startsWith('build:')) return 'Build';
  return 'Other';
}

/**
 * Strip the conventional commit prefix from a subject line.
 *
 * @param subject - The commit subject
 * @returns Clean description without prefix
 */
export function stripPrefix(subject: string): string {
  return subject.replace(/^[a-zA-Z]+(\([^)]*\))?[!]?:\s*/, '');
}

// ---------------------------------------------------------------------------
// Git log parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw git log output (pipe-delimited) into an array of Commit objects.
 *
 * Expected format per line: `hash|subject|author|date`
 *
 * @param logOutput - Raw git log output string
 * @returns Array of parsed commits
 */
export function parseGitLog(logOutput: string): Commit[] {
  const lines = logOutput
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
  return lines.map((line) => {
    const parts = line.split('|');
    return {
      hash: parts[0] || '',
      subject: parts[1] || '',
      author: parts[2] || '',
      date: parts[3] || '',
    };
  });
}

// ---------------------------------------------------------------------------
// Core generation
// ---------------------------------------------------------------------------

/**
 * Group commits into sections by conventional commit type.
 *
 * @param commits - Array of parsed commits
 * @returns Map of section name to commits in that section
 */
export function groupCommitsBySections(commits: Commit[]): Partial<Record<SectionName, Commit[]>> {
  const sections: Partial<Record<SectionName, Commit[]>> = {};
  for (const commit of commits) {
    const section = classifyCommit(commit.subject);
    if (!sections[section]) sections[section] = [];
    sections[section]!.push(commit);
  }
  return sections;
}

/**
 * Generate a complete release-note Markdown document from commits.
 *
 * @param commits   - Array of parsed commits
 * @param since     - The "since" date or tag string shown in the header
 * @param generated - Optional ISO date string for "Generated" header (defaults to today)
 * @returns Release note result with commit count, section counts, and markdown
 */
export function generateReleaseNotes(
  commits: Commit[],
  since: string,
  generated?: string
): ReleaseNoteResult {
  const sections = groupCommitsBySections(commits);

  const generatedDate = generated ?? new Date().toISOString().split('T')[0];

  let markdown = `# Release Notes\n\n`;
  markdown += `**Since:** ${since}\n`;
  markdown += `**Generated:** ${generatedDate}\n`;
  markdown += `**Total Commits:** ${commits.length}\n\n`;

  const sectionCounts: SectionCounts = {};

  for (const sectionName of SECTION_ORDER) {
    const items = sections[sectionName];
    if (!items || items.length === 0) continue;
    sectionCounts[sectionName] = items.length;

    markdown += `## ${sectionName}\n\n`;
    for (const commit of items) {
      const desc = stripPrefix(commit.subject);
      markdown += `- ${desc} (${commit.hash.substring(0, 7)}) - ${commit.author}\n`;
    }
    markdown += '\n';
  }

  return {
    commits: commits.length,
    sections: sectionCounts,
    markdown,
  };
}

/**
 * Write release-note markdown to a file, creating parent directories as needed.
 *
 * @param markdown - The markdown content to write
 * @param outPath  - Output file path
 */
export function writeReleaseNotes(markdown: string, outPath: string): void {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, markdown, 'utf8');
}

// ---------------------------------------------------------------------------
// SkillOutput builder
// ---------------------------------------------------------------------------

/**
 * Build a SkillOutput envelope for the release-note-crafter skill.
 *
 * @param result  - Release note result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildReleaseNoteOutput(
  result: ReleaseNoteResult,
  startMs: number
): SkillOutput<ReleaseNoteResult> {
  return {
    skill: 'release-note-crafter',
    status: 'success',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
