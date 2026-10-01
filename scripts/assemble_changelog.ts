#!/usr/bin/env node
/**
 * GF-02: per-PR changelog fragments.
 *
 * PRs no longer edit `CHANGELOG.md` directly — every PR that edited the top of
 * `[Unreleased]` conflicted with every other one. A user-visible change adds
 * one file instead:
 *
 *   changelog.d/<short-slug>.md
 *   ---
 *   category: Added            # Added | Changed | Deprecated | Removed | Fixed | Security
 *   ---
 *   - **Thing** — what changed for the user.
 *
 * Usage:
 *   pnpm kyberion changelog assemble            — merge every fragment into
 *       CHANGELOG.md `[Unreleased]` (newest first under the matching `###`
 *       heading) and delete the fragments (release step)
 *   pnpm kyberion changelog assemble --dry-run  — print the assembled file
 *   node --import ./scripts/ts-loader.mjs scripts/assemble_changelog.ts --check
 *       — validate fragment format only (the `changelog-fragments` PR gate)
 */

import * as path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { guardCliArgs, type CliGuardSpec } from './lib/cli-guard.js';

export const CHANGELOG_CATEGORIES = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;
export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

export interface ChangelogFragment {
  fileName: string;
  category: ChangelogCategory;
  body: string;
}

const FRAGMENT_DIR = 'changelog.d';
const FRAGMENT_NAME = /^[a-z0-9][a-z0-9-]{0,79}\.md$/u;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

function readRegularTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

export function parseChangelogFragment(
  fileName: string,
  content: string
): { fragment?: ChangelogFragment; errors: string[] } {
  const errors: string[] = [];
  if (!FRAGMENT_NAME.test(fileName)) {
    errors.push(`${fileName}: name must match <short-slug>.md (lowercase letters, digits, dashes)`);
  }
  const match = content.match(FRONTMATTER);
  if (!match) {
    return { errors: [...errors, `${fileName}: missing '---' front-matter with a category`] };
  }
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const field = line.match(/^([a-z_]+):\s*(.*?)\s*$/u);
    if (!field) {
      errors.push(`${fileName}: unreadable front-matter line: ${line}`);
      continue;
    }
    fields.set(field[1], field[2].replace(/^["']|["']$/gu, ''));
  }
  for (const key of fields.keys()) {
    if (key !== 'category') errors.push(`${fileName}: unknown front-matter field: ${key}`);
  }
  const category = fields.get('category');
  if (!category || !(CHANGELOG_CATEGORIES as readonly string[]).includes(category)) {
    errors.push(
      `${fileName}: category must be one of ${CHANGELOG_CATEGORIES.join(', ')} (got ${category ?? 'none'})`
    );
  }
  const body = match[2].replace(/\s+$/u, '').replace(/^\s*\n/u, '');
  if (!body.trim()) errors.push(`${fileName}: body is empty`);
  else if (!body.startsWith('- ')) {
    errors.push(`${fileName}: body must be a Markdown list item starting with '- '`);
  }
  if (/^#{1,6}\s/mu.test(body)) {
    errors.push(`${fileName}: body must not contain headings (the category picks the heading)`);
  }
  if (errors.length > 0) return { errors };
  return { fragment: { fileName, category: category as ChangelogCategory, body }, errors };
}

function sectionBounds(lines: readonly string[]): { start: number; end: number } {
  const start = lines.findIndex((line) => /^##\s*\[Unreleased\]/u.test(line));
  if (start === -1) throw new Error('CHANGELOG.md has no ## [Unreleased] section');
  const next = lines.findIndex((line, index) => index > start && /^##\s/u.test(line));
  return { start, end: next === -1 ? lines.length : next };
}

function categoryRank(line: string): number {
  const heading = line.match(/^###\s+(.+?)\s*$/u)?.[1];
  return heading ? (CHANGELOG_CATEGORIES as readonly string[]).indexOf(heading) : -1;
}

/**
 * Insert fragment bodies under the first exact `### <Category>` heading of
 * `[Unreleased]` (newest first, i.e. above the existing entries). A missing
 * heading is created before the first later-ranked category heading, or at the
 * end of the section. Fragments are applied in codepoint filename order so the
 * result does not depend on directory listing order or locale.
 */
export function assembleChangelog(
  changelog: string,
  fragments: readonly ChangelogFragment[]
): string {
  const ordered = [...fragments].sort((a, b) =>
    a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0
  );
  let lines = changelog.split('\n');
  for (const category of CHANGELOG_CATEGORIES) {
    const entries = ordered.filter((fragment) => fragment.category === category);
    if (entries.length === 0) continue;
    const bodyLines = entries.flatMap((fragment) => fragment.body.split('\n'));
    const { start, end } = sectionBounds(lines);
    const headingIndex = lines.findIndex(
      (line, index) => index > start && index < end && line.trimEnd() === `### ${category}`
    );
    if (headingIndex !== -1) {
      let insertAt = headingIndex + 1;
      while (insertAt < end && lines[insertAt].trim() === '') insertAt += 1;
      lines = [
        ...lines.slice(0, headingIndex + 1),
        '',
        ...bodyLines,
        ...(insertAt < end && lines[insertAt].startsWith('- ') ? [] : ['']),
        ...lines.slice(insertAt),
      ];
      continue;
    }
    const rank = CHANGELOG_CATEGORIES.indexOf(category);
    let insertAt = lines.findIndex(
      (line, index) => index > start && index < end && categoryRank(line) > rank
    );
    if (insertAt === -1) {
      insertAt = end;
      while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
    }
    lines = [
      ...lines.slice(0, insertAt),
      ...(lines[insertAt - 1]?.trim() === '' ? [] : ['']),
      `### ${category}`,
      '',
      ...bodyLines,
      '',
      ...lines.slice(insertAt).filter((line, index) => index > 0 || line.trim() !== ''),
    ];
  }
  return lines.join('\n');
}

export function loadChangelogFragments(rootDir = pathResolver.rootDir()): {
  fragments: ChangelogFragment[];
  errors: string[];
} {
  const dir = path.join(rootDir, FRAGMENT_DIR);
  if (!safeExistsSync(dir)) return { fragments: [], errors: [] };
  const fragments: ChangelogFragment[] = [];
  const errors: string[] = [];
  const names = safeReaddir(dir)
    .filter((name) => name !== 'README.md' && !name.startsWith('.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const parsed = parseChangelogFragment(name, readRegularTextFile(path.join(dir, name)));
    errors.push(...parsed.errors);
    if (parsed.fragment) fragments.push(parsed.fragment);
  }
  return { fragments, errors };
}

/** CU-01: `--help` / typos exit before CHANGELOG.md or changelog.d/ is rewritten. */
export const ASSEMBLE_CHANGELOG_CLI: CliGuardSpec = {
  command: 'pnpm kyberion changelog assemble',
  manifestId: 'script.changelog.assemble',
  options: [{ flag: '--check' }, { flag: '--dry-run' }, { flag: '--json' }, { flag: '--quiet' }],
};

export const main = defineScript({
  name: 'changelog:assemble',
  run(context) {
    if (guardCliArgs(context.argv, ASSEMBLE_CHANGELOG_CLI, context.print)) return undefined;
    const rootDir = pathResolver.rootDir();
    const { fragments, errors } = loadChangelogFragments(rootDir);
    if (errors.length > 0) {
      throw new ScriptExitError(
        1,
        ['invalid changelog fragments (see changelog.d/README.md):', ...errors]
          .map((line, index) => (index === 0 ? line : `- ${line}`))
          .join('\n')
      );
    }
    if (context.check) {
      context.print({ ok: true, fragments: fragments.length });
      return { fragments: fragments.length, changed: false };
    }
    const changelogPath = path.join(rootDir, 'CHANGELOG.md');
    const existing = readRegularTextFile(changelogPath);
    const updated = assembleChangelog(existing, fragments);
    if (context.dryRun) {
      context.print(updated);
      return { fragments: fragments.length, changed: updated !== existing };
    }
    if (fragments.length > 0) {
      safeWriteFile(changelogPath, updated, { encoding: 'utf8' });
      for (const fragment of fragments) {
        safeUnlinkSync(path.join(rootDir, FRAGMENT_DIR, fragment.fileName));
      }
    }
    context.print({
      ok: true,
      assembled: fragments.map((fragment) => `${FRAGMENT_DIR}/${fragment.fileName}`),
    });
    return { fragments: fragments.length, changed: updated !== existing };
  },
});

if (
  isDirectScript(import.meta.url, 'assemble_changelog.ts') ||
  isDirectScript(import.meta.url, 'assemble_changelog.js')
)
  void main();
