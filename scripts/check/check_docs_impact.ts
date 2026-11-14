/**
 * check_docs_impact.ts — documentation-impact report for a change set.
 *
 * Answers the question "did the docs that describe this change ride along
 * with it?": every changed path is matched against
 * knowledge/product/governance/docs-impact-map.json and each mapped doc
 * target is classified `updated` (it is in the diff too) or `not_updated`.
 * The mission docs-sync task (delivery-docs-sync in code-change-aidlc)
 * consumes this report; a `not_updated` finding is closed by updating the
 * doc or by recording why the surface does not apply.
 *
 *   pnpm check:docs-impact [--base <ref>] [--files a.ts,b.md]
 *                          [--out <path>] [--json] [--strict] [--map <path>]
 *
 * Advisory by default (exit 0 with findings printed); --strict exits 1 when
 * any mapped doc target is not_updated.
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeWriteFile } from '@agent/core/secure-io';
import { cliOptionValue, hasCliFlag, hasHelpFlag } from '@agent/core/cli-guard';
import { defineScript, isDirectScript } from '../lib/harness.js';
import { readSafeJsonFile } from '../lib/json-input.js';
import { collectChangedFiles, type GitRunner } from '../run_checks.js';

const DEFAULT_MAP_PATH = 'knowledge/product/governance/docs-impact-map.json';

export interface DocsImpactRule {
  change: string;
  docs: string[];
  note?: string;
}

export interface DocsImpactMap {
  rules: DocsImpactRule[];
  ignore?: string[];
}

export type DocsImpactStatus = 'updated' | 'not_updated';

export interface DocsImpactFinding {
  change: string;
  doc: string;
  status: DocsImpactStatus;
  note?: string;
}

export interface DocsImpactReport {
  base: string;
  mergeBase: string;
  changed: string[];
  findings: DocsImpactFinding[];
  /** Changed paths that matched a rule whose docs list is empty — no doc surface expected. */
  noDocsExpected: { change: string; note?: string }[];
  /** Changed paths that matched no rule and no ignore glob. */
  unmapped: string[];
  /** Changed paths skipped via the map's ignore globs. */
  ignored: string[];
  counts: { updated: number; not_updated: number };
}

/** Glob subset identical to check_tier_hygiene.ts: literal segments, `*`, `**`, `?`. */
function globToRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i += 1;
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
  return new RegExp(`^${re}$`, 'u');
}

function normalizePath(filePath: string): string {
  let normalized = filePath.trim().replace(/\\/gu, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

/**
 * A doc target ending in `/` is a directory prefix: it counts as updated when a
 * documentation file (`.md`) under it changed. Restricting to `.md` keeps a rule
 * like `governance/*.json -> governance/` from being vacuously satisfied by the
 * triggering data file itself.
 */
function docTargetUpdated(target: string, changed: Set<string>): boolean {
  if (target.endsWith('/')) {
    return [...changed].some((file) => file.startsWith(target) && file.endsWith('.md'));
  }
  return changed.has(target);
}

/** Structural check for a loaded map — a malformed map fails with a named error, not a TypeError mid-eval. */
export function assertDocsImpactMapShape(
  value: unknown,
  source = 'docs-impact map'
): asserts value is DocsImpactMap {
  if (!value || typeof value !== 'object' || !Array.isArray((value as DocsImpactMap).rules)) {
    throw new Error(`${source}: expected { rules: [...] }`);
  }
  const map = value as DocsImpactMap;
  for (const [index, rule] of map.rules.entries()) {
    if (
      !rule ||
      typeof rule.change !== 'string' ||
      !Array.isArray(rule.docs) ||
      rule.docs.some((doc) => typeof doc !== 'string')
    ) {
      throw new Error(`${source}: rule ${index} must be { change: string, docs: string[] }`);
    }
  }
  if (
    map.ignore !== undefined &&
    (!Array.isArray(map.ignore) || map.ignore.some((g) => typeof g !== 'string'))
  ) {
    throw new Error(`${source}: ignore must be a string array`);
  }
}

export function evaluateDocsImpact(changedFiles: string[], map: DocsImpactMap): DocsImpactReport {
  const changed = new Set(changedFiles.map(normalizePath).filter(Boolean));
  const ignore = (map.ignore ?? []).map(globToRegex);
  const rules = map.rules.map((rule) => ({ ...rule, regex: globToRegex(rule.change) }));

  const findings: DocsImpactFinding[] = [];
  const noDocsExpected: { change: string; note?: string }[] = [];
  const unmapped: string[] = [];
  const ignored: string[] = [];

  for (const file of changed) {
    if (ignore.some((regex) => regex.test(file))) {
      ignored.push(file);
      continue;
    }
    const matched = rules.filter((rule) => rule.regex.test(file));
    if (matched.length === 0) {
      unmapped.push(file);
      continue;
    }
    // A rule with an empty docs list wins only when no matched rule expects docs.
    if (!matched.some((rule) => rule.docs.length > 0)) {
      const note = matched.find((rule) => rule.note)?.note;
      noDocsExpected.push({ change: file, ...(note ? { note } : {}) });
      continue;
    }
    for (const rule of matched) {
      for (const doc of rule.docs) {
        const finding: DocsImpactFinding = {
          change: file,
          doc,
          status: docTargetUpdated(doc, changed) ? 'updated' : 'not_updated',
          ...(rule.note ? { note: rule.note } : {}),
        };
        // The same (change, doc) pair can come from two overlapping rules — keep the first.
        if (!findings.some((f) => f.change === file && f.doc === doc)) findings.push(finding);
      }
    }
  }

  const updated = findings.filter((f) => f.status === 'updated').length;
  return {
    base: '',
    mergeBase: '',
    changed: [...changed].sort(),
    findings: findings.sort((a, b) => `${a.change}${a.doc}`.localeCompare(`${b.change}${b.doc}`)),
    noDocsExpected: noDocsExpected.sort((a, b) => a.change.localeCompare(b.change)),
    unmapped: unmapped.sort(),
    ignored: ignored.sort(),
    counts: { updated, not_updated: findings.length - updated },
  };
}

export function renderDocsImpactMarkdown(report: DocsImpactReport): string {
  const lines: string[] = [
    '# Docs impact report',
    '',
    `- Base: ${report.base || '(files list)'}${report.mergeBase ? ` (merge-base ${report.mergeBase})` : ''}`,
    `- Changed files: ${report.changed.length} (${report.ignored.length} ignored, ${report.unmapped.length} unmapped)`,
    `- Findings: ${report.counts.updated} updated, ${report.counts.not_updated} not_updated`,
    '',
  ];
  const notUpdated = report.findings.filter((f) => f.status === 'not_updated');
  if (notUpdated.length > 0) {
    lines.push('## Doc surfaces NOT updated in this diff', '');
    for (const finding of notUpdated) {
      lines.push(
        `- \`${finding.doc}\` — expected to reflect \`${finding.change}\`${finding.note ? ` (${finding.note})` : ''}`
      );
    }
    lines.push(
      '',
      '> Close each item by updating the doc in this change, or by recording below why the surface does not apply.',
      ''
    );
  }
  const updated = report.findings.filter((f) => f.status === 'updated');
  if (updated.length > 0) {
    lines.push('## Doc surfaces updated in this diff', '');
    for (const finding of updated) {
      lines.push(`- \`${finding.doc}\` — covers \`${finding.change}\``);
    }
    lines.push('');
  }
  if (report.unmapped.length > 0) {
    lines.push('## Changed paths with no impact rule', '');
    for (const file of report.unmapped) lines.push(`- \`${file}\``);
    lines.push(
      '',
      '> If any of these alter observable behavior, add a rule to docs-impact-map.json or record why no doc applies.',
      ''
    );
  }
  lines.push('## Resolution', '');
  lines.push(
    '<!-- one line per not_updated finding: `<doc>` — updated | not applicable: <reason> -->',
    ''
  );
  return lines.join('\n');
}

interface ParsedArgs {
  base?: string;
  files?: string[];
  out?: string;
  map?: string;
  strict: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const filesRaw = cliOptionValue(argv, '--files');
  return {
    base: cliOptionValue(argv, '--base'),
    files: filesRaw ? filesRaw.split(',').map(normalizePath).filter(Boolean) : undefined,
    out: cliOptionValue(argv, '--out'),
    map: cliOptionValue(argv, '--map'),
    strict: hasCliFlag(argv, '--strict'),
    help: hasHelpFlag(argv),
  };
}

export function docsImpactUsage(): string {
  return [
    'Usage: pnpm check:docs-impact [options]',
    '',
    '  --base <ref>       Diff against merge-base with <ref> (default: origin/main, then main)',
    '  --files <a,b>      Explicit changed-path list (skips git)',
    '  --out <path>       Also write the markdown report to a repo-local file',
    '  --map <path>       Alternate docs-impact-map.json',
    '  --strict           Exit 1 when any mapped doc surface is not_updated',
    '  --json             Print the report as JSON',
  ].join('\n');
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  json = false,
  deps: { git?: GitRunner } = {}
): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    print(docsImpactUsage());
    return;
  }
  const mapPath = assertSafeRepositoryPath(
    path.resolve(pathResolver.rootDir(), args.map ?? DEFAULT_MAP_PATH)
  );
  const map = readSafeJsonFile<DocsImpactMap>(mapPath, 'docs-impact map');
  assertDocsImpactMapShape(map, `docs-impact map ${args.map ?? DEFAULT_MAP_PATH}`);

  let report: DocsImpactReport;
  if (args.files) {
    report = evaluateDocsImpact(args.files, map);
  } else {
    const { files, base, mergeBase } = collectChangedFiles(args.base, deps.git);
    report = evaluateDocsImpact(files, map);
    report.base = base;
    report.mergeBase = mergeBase;
  }

  const markdown = renderDocsImpactMarkdown(report);
  if (args.out) {
    const outPath = assertSafeRepositoryPath(path.resolve(pathResolver.rootDir(), args.out), {
      allowMissingLeaf: true,
    });
    safeWriteFile(outPath, markdown);
  }
  print(json ? report : markdown);
  if (args.strict && report.counts.not_updated > 0) {
    throw new Error(
      `${report.counts.not_updated} documented surface(s) not updated in this diff — update the doc or record why it does not apply`
    );
  }
}

const script = defineScript({
  name: 'check:docs-impact',
  flags: ['json'],
  run: ({ argv, print, json }) => main(argv, print, json),
});
if (
  isDirectScript(import.meta.url, 'check_docs_impact.ts') ||
  isDirectScript(import.meta.url, 'check_docs_impact.js')
) {
  void script();
}
