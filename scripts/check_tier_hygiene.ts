/**
 * Tier Hygiene Check — scans public-tier files for organization-specific
 * leaks (internal URLs, tenant subdomains, company / customer identifiers)
 * that belong in knowledge/confidential/{org}/ instead.
 *
 * Policy: knowledge/public/governance/tier-hygiene-policy.json
 * Invoke: pnpm check:tier-hygiene
 */

import { pathResolver, safeLstat, safeReadFile, safeReaddir } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './refactor/cli-input.js';

interface DeniedPattern {
  name: string;
  regex: string;
  rationale: string;
}

interface Policy {
  version: string;
  description?: string;
  scan_paths: string[];
  skip_paths?: string[];
  denied_patterns: DeniedPattern[];
  denied_substrings?: string[];
  allowlist_patterns?: string[];
}

interface Violation {
  file: string;
  line: number;
  pattern: string;
  matched: string;
  rationale: string;
}

const POLICY_PATH = 'knowledge/public/governance/tier-hygiene-policy.json';

async function loadPolicy(): Promise<Policy> {
  const absolute = pathResolver.rootResolve(POLICY_PATH);
  return readJsonFile<Policy>(absolute);
}

function buildAllowlist(policy: Policy): RegExp[] {
  return (policy.allowlist_patterns ?? []).map((p) => new RegExp(p, 'giu'));
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function isAllowlisted(match: string, allowlist: RegExp[]): boolean {
  return allowlist.some((re) => {
    re.lastIndex = 0;
    return re.test(match);
  });
}

/**
 * Translate a glob pattern (subset: literal segments, `*`, `**`, and simple
 * `*.{ext1,ext2}` suffix groups) into a RegExp anchored to the start /end
 * of a forward-slash-separated relative path.
 */
function globToRegex(glob: string): RegExp {
  // Expand brace alternations like *.{ts,tsx}
  const expanded: string[] = [];
  const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/u);
  if (braceMatch) {
    const [, head, choices, tail] = braceMatch;
    for (const choice of choices.split(',')) expanded.push(`${head}${choice.trim()}${tail}`);
  } else {
    expanded.push(glob);
  }
  const parts = expanded.map((g) => {
    let re = '';
    let i = 0;
    while (i < g.length) {
      const ch = g[i];
      if (ch === '*' && g[i + 1] === '*') {
        // **  — zero or more path segments
        re += '.*';
        i += 2;
        if (g[i] === '/') i += 1;
      } else if (ch === '*') {
        re += '[^/]*';
        i += 1;
      } else if (ch === '?') {
        re += '[^/]';
        i += 1;
      } else if ('.+^$()[]{}|\\'.includes(ch)) {
        re += `\\${ch}`;
        i += 1;
      } else {
        re += ch;
        i += 1;
      }
    }
    return re;
  });
  return new RegExp(`^(?:${parts.join('|')})$`);
}

function walk(root: string, current: string, collected: string[]): void {
  let entries: string[];
  try {
    entries = safeReaddir(path.join(root, current));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') {
      continue;
    }
    const rel = current ? `${current}/${entry}` : entry;
    const fullPath = path.join(root, rel);
    let stat;
    try {
      stat = safeLstat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, rel, collected);
    } else if (stat.isFile()) {
      collected.push(rel);
    }
  }
}

export async function scan(): Promise<Violation[]> {
  const policy = await loadPolicy();
  const root = pathResolver.rootDir();

  const scanRegexes = policy.scan_paths.map(globToRegex);
  const skipRegexes = (policy.skip_paths ?? []).map(globToRegex);

  const allFiles: string[] = [];
  walk(root, '', allFiles);

  const files = allFiles.filter(
    (rel) =>
      scanRegexes.some((re) => re.test(rel)) && !skipRegexes.some((re) => re.test(rel)),
  );

  const allowlist = buildAllowlist(policy);
  const violations: Violation[] = [];

  for (const rel of files) {
    const absolute = path.join(root, rel);
    let content: string;
    try {
      content = safeReadFile(absolute, { encoding: 'utf8' }) as string;
    } catch {
      continue;
    }

    // Denied regex patterns
    for (const pattern of policy.denied_patterns) {
      const re = new RegExp(pattern.regex, 'giu');
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        // Expand match window to include enclosing allowlist tokens
        const window = content.slice(
          Math.max(0, match.index - 40),
          Math.min(content.length, match.index + match[0].length + 40),
        );
        if (isAllowlisted(window, allowlist)) continue;
        violations.push({
          file: rel,
          line: lineAt(content, match.index),
          pattern: pattern.name,
          matched: match[0],
          rationale: pattern.rationale,
        });
        if (re.lastIndex === match.index) re.lastIndex += 1;
      }
    }

    // Denied substrings (exact, case-insensitive)
    for (const needle of policy.denied_substrings ?? []) {
      const lowered = content.toLowerCase();
      let from = 0;
      while (true) {
        const idx = lowered.indexOf(needle.toLowerCase(), from);
        if (idx === -1) break;
        const hit = content.slice(idx, idx + needle.length);
        const window = content.slice(
          Math.max(0, idx - 40),
          Math.min(content.length, idx + needle.length + 40),
        );
        if (!isAllowlisted(window, allowlist)) {
          violations.push({
            file: rel,
            line: lineAt(content, idx),
            pattern: `substring:${needle}`,
            matched: hit,
            rationale: `Denied substring. Move to confidential/{org}/.`,
          });
        }
        from = idx + needle.length;
      }
    }
  }

  return violations;
}

export async function main(): Promise<void> {
  const violations = await scan();
  if (violations.length === 0) {
    console.log('[check:tier-hygiene] OK');
    return;
  }
  console.error(`[check:tier-hygiene] ${violations.length} violation(s) detected:`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.pattern}] ${v.matched}`);
    console.error(`    → ${v.rationale}`);
  }
  console.error('');
  console.error(
    'Fix by moving the value into knowledge/confidential/{org}/ and using a placeholder (${VAR} / <PLACEHOLDER>) in public. ' +
      'Legitimate industry terms should be added to allowlist_patterns in the tier-hygiene-policy.',
  );
  process.exit(1);
}

const isDirectExecution =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error(`[check:tier-hygiene] fatal: ${err?.message ?? err}`);
    process.exit(2);
  });
}
