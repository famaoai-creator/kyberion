/**
 * Tier Hygiene Check — scans public-tier files for organization-specific
 * leaks (internal URLs, tenant subdomains, company / customer identifiers)
 * that belong in knowledge/confidential/{org}/ instead.
 *
 * Policy: knowledge/product/governance/tier-hygiene-policy.json
 * Invoke: pnpm check:tier-hygiene
 */

import { pathResolver } from '@agent/core/path-resolver';
import { defineCatalog, readTextFile } from '@agent/core/foundation';
import { safeLstat, safeReaddir } from '@agent/core/secure-io';
import * as path from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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

export interface Violation {
  file: string;
  line: number;
  pattern: string;
  matched: string;
  rationale: string;
}

const POLICY_PATH = 'knowledge/product/governance/tier-hygiene-policy.json';
const policyCatalog = defineCatalog<Policy>({
  id: 'tier-hygiene-policy',
  path: () => pathResolver.rootResolve(POLICY_PATH),
  schema: pathResolver.knowledge('product/schemas/tier-hygiene-policy.schema.json'),
});

async function loadPolicy(): Promise<Policy> {
  return policyCatalog.load();
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

function walk(
  root: string,
  current: string,
  collected: string[],
  structuralViolations: Violation[]
): void {
  let entries: string[];
  try {
    entries = safeReaddir(path.join(root, current));
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = current ? `${current}/${entry}` : entry;
    const fullPath = path.join(root, rel);

    // Check structural constraints for knowledge tier (KM-04)
    if (rel.startsWith('knowledge/')) {
      if (entry === '.git' && rel !== '.git') {
        structuralViolations.push({
          file: rel,
          line: 0,
          pattern: 'nested-git',
          matched: entry,
          rationale: 'Nested .git repositories are not allowed in knowledge/',
        });
      }
      if (entry.startsWith('MSN-TEST-')) {
        structuralViolations.push({
          file: rel,
          line: 0,
          pattern: 'test-mission-pollution',
          matched: entry,
          rationale: 'Test missions (MSN-TEST-*) must not be written to the knowledge/ store',
        });
      }
    }

    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') {
      continue;
    }

    let stat;
    try {
      stat = safeLstat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, rel, collected, structuralViolations);
    } else if (stat.isFile()) {
      collected.push(rel);
    }
  }
}

// ── KP-07: persistent-tier (personal / confidential) test-fixture pollution ──
//
// knowledge/personal/ and knowledge/confidential/ are gitignored — they hold
// the operator's real, locally-generated identity, vision, and promoted
// memory, never committed to the repo. A test that writes fixture content
// straight into those real paths (instead of a temp dir / customer overlay)
// permanently pollutes the operator's live knowledge store. This complements
// the structural MSN-TEST- directory-name check in walk() above by scanning
// *file content* under the persistent tier (plus the committed, generated
// HINTS.md) for known fixture signatures.

const PERSISTENT_TIER_ROOT_RE = /^knowledge\/(personal|confidential)\//;
const HINTS_PATH = 'knowledge/product/governance/HINTS.md';

export const PERSISTENT_TIER_FIXTURE_PATTERNS: DeniedPattern[] = [
  {
    name: 'test-mission-slug',
    regex: '\\bMSN-TEST-[A-Z0-9-]*\\b',
    rationale:
      'MSN-TEST-* mission slug found in persistent-tier content. A test wrote/promoted a ' +
      'fixture mission into the real knowledge store instead of a temp dir / customer overlay.',
  },
  {
    name: 'sovereign-test-placeholder',
    regex: '"sovereign"\\s*:\\s*"test"',
    rationale:
      'my-identity.json (or similar) holds the literal test placeholder {"sovereign":"test",...} ' +
      'instead of a real onboarding-generated identity — a test overwrote the real profile.',
  },
];

/**
 * Splits a governed HINTS.md-style file into `## <header>` sections and
 * groups them by normalized body (header line and any `source_ref:` line
 * stripped, since those legitimately vary per promotion even when the
 * underlying hint is a repeated duplicate). Returns only groups with more
 * than one member — i.e. actual duplicates.
 */
export function findDuplicateHintsSections(
  content: string
): Array<{ headers: string[]; count: number }> {
  const sectionRe = /\n## ([^\n]+)\n([\s\S]*?)(?=\n## |$)/g;
  const bySignature = new Map<string, string[]>();
  let match: RegExpExecArray | null;
  const padded = content.startsWith('\n') ? content : `\n${content}`;
  while ((match = sectionRe.exec(padded)) !== null) {
    const header = match[1].trim();
    const signature = match[2]
      .split('\n')
      .filter((line) => !line.trim().startsWith('source_ref:'))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
    if (!signature) continue;
    const headers = bySignature.get(signature) ?? [];
    headers.push(header);
    bySignature.set(signature, headers);
  }
  return [...bySignature.values()]
    .filter((headers) => headers.length > 1)
    .map((headers) => ({ headers, count: headers.length }));
}

export function scanPersistentTierFixturePollution(root: string, files: string[]): Violation[] {
  const violations: Violation[] = [];
  const targets = files.filter((rel) => PERSISTENT_TIER_ROOT_RE.test(rel) || rel === HINTS_PATH);

  for (const rel of targets) {
    let content: string;
    try {
      content = readTextFile(path.join(root, rel));
    } catch {
      // Fail-open: an unreadable file is not this check's concern.
      continue;
    }

    for (const pattern of PERSISTENT_TIER_FIXTURE_PATTERNS) {
      const re = new RegExp(pattern.regex, 'gu');
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
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

    if (rel === HINTS_PATH) {
      for (const group of findDuplicateHintsSections(content)) {
        violations.push({
          file: rel,
          line: 0,
          pattern: 'duplicate-hints-section',
          matched: `${group.count}x: ${group.headers.join(', ')}`,
          rationale:
            'Duplicate HINTS.md sections with identical body content (differing only by header ' +
            'id / source_ref) indicate a test repeatedly promoted the same fixture into the ' +
            'governed hints file instead of using an isolated HINTS path.',
        });
      }
    }
  }

  return violations;
}

export async function scan(): Promise<Violation[]> {
  const policy = await loadPolicy();
  const root = pathResolver.rootDir();

  const scanRegexes = policy.scan_paths.map(globToRegex);
  const skipRegexes = (policy.skip_paths ?? []).map(globToRegex);

  const allFiles: string[] = [];
  const violations: Violation[] = [];
  walk(root, '', allFiles, violations);
  // NOTE (KP-07): scanPersistentTierFixturePollution() / findDuplicateHintsSections()
  // above extend this module to detect test-fixture pollution in the
  // persistent tier (knowledge/personal/, knowledge/confidential/) and
  // HINTS.md duplication. They are intentionally NOT wired into this
  // default scan(): knowledge/personal/ is gitignored, per-machine local
  // state (secure-io additionally role-gates reads to it — see
  // security-policy.json's "Sovereign Sanctuary"), so folding it into the
  // shared `pnpm check:tier-hygiene` / `pnpm run validate` gate would make
  // CI fail based on this box's local onboarding state rather than
  // anything in the git tree, and would trip concurrently-running agents
  // sharing this checkout. See tests/knowledge-store-purity.test.ts for
  // hermetic, seeded-fixture coverage of both functions, and STATUS.md for
  // the current pollution inventory / cleanup record. A caller that wants
  // this enforced against the live tree can call
  // scanPersistentTierFixturePollution(pathResolver.rootDir(), allFiles)
  // directly, ideally wrapped in withExecutionContext('ecosystem_architect', ...)
  // so the personal/confidential tier is actually readable.

  const files = allFiles.filter(
    (rel) => scanRegexes.some((re) => re.test(rel)) && !skipRegexes.some((re) => re.test(rel))
  );

  const allowlist = buildAllowlist(policy);

  for (const rel of files) {
    const absolute = path.join(root, rel);
    let content: string;
    try {
      content = readTextFile(absolute);
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
          Math.min(content.length, match.index + match[0].length + 40)
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
          Math.min(content.length, idx + needle.length + 40)
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

export const runCheckTierHygiene = defineScript({
  name: 'check:tier-hygiene',
  flags: [],
  async run(context) {
    const violations = await scan();
    if (violations.length === 0) {
      context.print('[check:tier-hygiene] OK');
      return { violations };
    }
    throw new ScriptExitError(
      1,
      [
        `[check:tier-hygiene] ${violations.length} violation(s) detected:`,
        ...violations.flatMap((v) => [
          `  ${v.file}:${v.line} [${v.pattern}] ${v.matched}`,
          `    → ${v.rationale}`,
        ]),
        '',
        'Fix by moving the value into knowledge/confidential/{org}/ and using a placeholder (${VAR} / <PLACEHOLDER>) in public. ' +
          'Legitimate industry terms should be added to allowlist_patterns in the tier-hygiene-policy.',
      ].join('\n')
    );
  },
});

if (
  isDirectScript(import.meta.url, 'check_tier_hygiene.ts') ||
  isDirectScript(import.meta.url, 'check_tier_hygiene.js')
)
  void runCheckTierHygiene();
