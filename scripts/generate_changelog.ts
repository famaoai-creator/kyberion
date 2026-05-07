#!/usr/bin/env node
/**
 * Generate CHANGELOG entries from Conventional Commits.
 *
 * Reads commits since the latest tag (or all commits if no tag yet),
 * groups them by Conventional Commit type, and prints a markdown section
 * suitable for prepending to CHANGELOG.md.
 *
 * Modes:
 *   pnpm tsx scripts/generate_changelog.ts [--from <tag>] [--to <ref>] [--prepend]
 *
 *   --from <tag>   Start commit (exclusive). Default: latest git tag, or root commit if none.
 *   --to <ref>     End commit (inclusive). Default: HEAD.
 *   --prepend      Prepend the generated section to CHANGELOG.md (under the [Unreleased] section).
 *
 * The tool does NOT auto-bump version numbers — that's part of the release runbook.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');

interface ParsedCommit {
  hash: string;
  shortHash: string;
  type: string;
  scope?: string;
  breaking: boolean;
  subject: string;
  body: string;
}

const TYPE_LABELS: Record<string, string> = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Performance',
  refactor: 'Changed (internal)',
  docs: 'Documentation',
  test: 'Tests',
  build: 'Build',
  ci: 'CI',
  chore: 'Chore',
  revert: 'Reverted',
  security: 'Security',
};

const ORDER = ['feat', 'fix', 'security', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'];

function git(args: string[]): string {
  return execSync(`git ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, { cwd: ROOT })
    .toString()
    .trim();
}

function findLatestTag(): string | null {
  try {
    return git(['describe', '--tags', '--abbrev=0']);
  } catch {
    return null;
  }
}

function listCommits(from: string | null, to: string): ParsedCommit[] {
  const range = from ? `${from}..${to}` : to;
  const sep = '';
  const fieldSep = '';
  const fmt = ['%H', '%h', '%s', '%b'].join(fieldSep) + sep;
  const raw = git(['log', `--format=${fmt}`, range]);
  if (!raw) return [];
  return raw
    .split(sep)
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => {
      const [hash, shortHash, subject, body] = line.split(fieldSep);
      return parseCommit(hash, shortHash, subject ?? '', body ?? '');
    });
}

function parseCommit(hash: string, shortHash: string, subject: string, body: string): ParsedCommit {
  const m = subject.match(/^(?<type>[a-z]+)(\((?<scope>[^)]+)\))?(?<breaking>!?):\s*(?<rest>.*)$/);
  if (!m || !m.groups) {
    return {
      hash,
      shortHash,
      type: 'other',
      breaking: false,
      subject,
      body,
    };
  }
  const breaking = m.groups.breaking === '!' || /BREAKING CHANGE:/.test(body);
  return {
    hash,
    shortHash,
    type: m.groups.type,
    scope: m.groups.scope,
    breaking,
    subject: m.groups.rest,
    body,
  };
}

function classify(c: ParsedCommit): string {
  if (c.breaking) return 'breaking';
  return c.type;
}

function group(commits: ParsedCommit[]): Map<string, ParsedCommit[]> {
  const map = new Map<string, ParsedCommit[]>();
  for (const c of commits) {
    const key = classify(c);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  return map;
}

function renderSection(commits: ParsedCommit[], from: string | null, to: string): string {
  if (commits.length === 0) {
    return `_No commits between ${from ?? 'root'} and ${to}._\n`;
  }

  const groups = group(commits);
  const lines: string[] = [];

  // Breaking first
  const breaking = groups.get('breaking') ?? [];
  if (breaking.length > 0) {
    lines.push('### ⚠ BREAKING CHANGES');
    for (const c of breaking) {
      const scope = c.scope ? `**${c.scope}**: ` : '';
      lines.push(`- ${scope}${c.subject} (\`${c.shortHash}\`)`);
    }
    lines.push('');
  }

  for (const type of ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;
    const label = TYPE_LABELS[type] ?? type;
    lines.push(`### ${label}`);
    for (const c of group) {
      if (c.breaking) continue; // already shown
      const scope = c.scope ? `**${c.scope}**: ` : '';
      lines.push(`- ${scope}${c.subject} (\`${c.shortHash}\`)`);
    }
    lines.push('');
  }

  // "other" — non-conventional commits
  const other = groups.get('other');
  if (other && other.length > 0) {
    lines.push('### Uncategorized');
    for (const c of other) {
      lines.push(`- ${c.subject} (\`${c.shortHash}\`)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function prependToChangelog(content: string): void {
  if (!safeExistsSync(CHANGELOG_PATH)) {
    safeWriteFile(CHANGELOG_PATH, `# Changelog\n\n## [Unreleased]\n\n${content}`, { encoding: 'utf8' });
    return;
  }
  const existing = safeReadFile(CHANGELOG_PATH, { encoding: 'utf8' }) as string;
  const unreleasedRe = /(##\s*\[Unreleased\][^\n]*\n)/;
  if (unreleasedRe.test(existing)) {
    const updated = existing.replace(unreleasedRe, `$1\n${content}\n`);
    safeWriteFile(CHANGELOG_PATH, updated, { encoding: 'utf8' });
  } else {
    const updated = `# Changelog\n\n## [Unreleased]\n\n${content}\n${existing.replace(/^#\s*Changelog\s*\n/, '')}`;
    safeWriteFile(CHANGELOG_PATH, updated, { encoding: 'utf8' });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let from: string | null = null;
  let to = 'HEAD';
  let prepend = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') from = args[++i];
    else if (args[i] === '--to') to = args[++i];
    else if (args[i] === '--prepend') prepend = true;
  }
  if (!from) from = findLatestTag();

  const commits = listCommits(from, to);
  const section = renderSection(commits, from, to);

  if (prepend) {
    prependToChangelog(section);
    console.log(`✅ Prepended to ${CHANGELOG_PATH}`);
  } else {
    console.log(`# Changes since ${from ?? 'root'} (${commits.length} commits)\n`);
    console.log(section);
  }
}

main();
