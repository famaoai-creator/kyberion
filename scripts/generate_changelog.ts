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

import * as path from 'node:path';
import { resolveChangelogPolicy } from '@agent/core/changelog-policy';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExec, safeExistsSync, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const ROOT = pathResolver.rootDir();
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

const ORDER = [
  'feat',
  'fix',
  'security',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

function git(args: string[]): string {
  return safeExec('git', args, { cwd: ROOT }).trim();
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
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
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
  const policy = resolveChangelogPolicy();
  if (commits.length === 0) {
    return `${policy.no_commits_template.replace('{from}', from ?? 'root').replace('{to}', to)}\n`;
  }

  const groups = group(commits);
  const lines: string[] = [];

  // Breaking first
  const breaking = groups.get('breaking') ?? [];
  if (breaking.length > 0) {
    lines.push(`### ${policy.breaking_changes_title}`);
    for (const c of breaking) {
      const scope = c.scope ? `**${c.scope}**: ` : '';
      lines.push(`- ${scope}${c.subject} (\`${c.shortHash}\`)`);
    }
    lines.push('');
  }

  for (const type of ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;
    const label = policy.type_labels[type] ?? type;
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
    lines.push(`### ${policy.uncategorized_title}`);
    for (const c of other) {
      lines.push(`- ${c.subject} (\`${c.shortHash}\`)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildPrependedChangelog(existing: string | null, content: string): string {
  if (existing === null) return `# Changelog\n\n## [Unreleased]\n\n${content}`;
  const unreleasedRe = /(##\s*\[Unreleased\][^\n]*\n)/;
  if (unreleasedRe.test(existing)) {
    return existing.replace(unreleasedRe, `$1\n${content}\n`);
  }
  return `# Changelog\n\n## [Unreleased]\n\n${content}\n${existing.replace(/^#\s*Changelog\s*\n/, '')}`;
}

export const main = defineScript({
  name: 'generate:changelog',
  run(context) {
    const args = context.argv;
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
      const existing = safeExistsSync(CHANGELOG_PATH) ? readTextFile(CHANGELOG_PATH) : null;
      const updated = buildPrependedChangelog(existing, section);
      const changed = existing !== updated;
      if (context.check && changed) {
        throw new ScriptExitError(1, '', true, {
          path: CHANGELOG_PATH,
          changed,
          mode: 'prepend',
        });
      }
      if (!context.dryRun && !context.check) {
        safeWriteFile(CHANGELOG_PATH, updated, { encoding: 'utf8' });
      }
      context.print(
        context.json
          ? { path: CHANGELOG_PATH, changed, mode: context.dryRun ? 'dry-run' : 'prepend' }
          : context.dryRun
            ? `Would prepend to ${CHANGELOG_PATH}`
            : `✅ Prepended to ${CHANGELOG_PATH}`
      );
    } else {
      const policy = resolveChangelogPolicy();
      const report = {
        from: from ?? 'root',
        to,
        count: commits.length,
        section,
      };
      context.print(
        context.json
          ? report
          : `${policy.header_template
              .replace('{from}', from ?? 'root')
              .replace('{count}', String(commits.length))}\n${section}`
      );
      return report;
    }
  },
});

if (
  isDirectScript(import.meta.url, 'generate_changelog.ts') ||
  isDirectScript(import.meta.url, 'generate_changelog.js')
)
  void main();

export { parseCommit, classify, renderSection };
