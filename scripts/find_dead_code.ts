#!/usr/bin/env node
/**
 * Dead Code Finder (Phase C'-9 — advisory only).
 *
 * Identifies *candidates* for dead code removal. **Does not delete anything.**
 *
 * Heuristic (intentionally conservative — false positives need human review):
 *
 *  1. Walk all .ts files under libs/ and scripts/ (excluding *.test.ts and dist/).
 *  2. For each file, extract its top-level exported symbols.
 *  3. For each exported symbol, grep across the rest of the workspace
 *     (excluding the file itself, dist/, node_modules/, and *.test.ts) to count usages.
 *  4. If usage count is 0, the symbol is a candidate for removal.
 *  5. Group candidates by file. A file with 100% candidates is itself a removal candidate.
 *
 * What this WILL NOT detect:
 *  - Symbols used only via dynamic imports / `require()`.
 *  - Symbols referenced only in pipelines/ JSON or knowledge/ markdown.
 *  - Symbols that are part of a public API contract (these are legitimately exported even when "unused" internally).
 *
 * Use the report as a starting list, then verify each candidate by hand
 * before deletion. Always run full validate + e2e before committing removals.
 *
 * Output: prints to stdout; writes machine-readable JSON to
 * docs/legal/dead-code-candidates.json (next to the license audit report).
 */

import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from '@agent/core';

interface ExportedSymbol {
  file: string;
  name: string;
  line: number;
  kind: 'function' | 'class' | 'const' | 'type' | 're-export' | 'unknown';
}

interface DeadCodeCandidate extends ExportedSymbol {
  external_usages: number;
  internal_usages: number;
}

const ROOT = pathResolver.rootDir();
const REPORT_PATH = path.join(ROOT, 'docs', 'legal', 'dead-code-candidates.json');

const SCAN_ROOTS = [
  path.join(ROOT, 'libs'),
  path.join(ROOT, 'scripts'),
];
const SEARCH_ROOTS = [
  path.join(ROOT, 'libs'),
  path.join(ROOT, 'scripts'),
  path.join(ROOT, 'satellites'),
  path.join(ROOT, 'presence'),
  path.join(ROOT, 'tests'),
  path.join(ROOT, 'pipelines'),
  path.join(ROOT, 'docs'),
];

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', 'active']);
const EXCLUDE_FILES = (p: string): boolean =>
  p.endsWith('.d.ts') ||
  p.endsWith('.d.ts.map') ||
  p.endsWith('.js.map') ||
  p.endsWith('.tsbuildinfo');

// Files to NEVER flag as candidates (public API surface, by definition exported "for outside").
const PUBLIC_API_PATHS = new Set([
  'libs/core/index.ts',
]);

function walkTs(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = safeStat(full);
    if (stat.isDirectory()) {
      out.push(...walkTs(full));
    } else if (stat.isFile() && full.endsWith('.ts') && !full.endsWith('.test.ts') && !EXCLUDE_FILES(full)) {
      out.push(full);
    }
  }
  return out;
}

function walkAny(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = safeStat(full);
    if (stat.isDirectory()) {
      out.push(...walkAny(full));
    } else if (stat.isFile() && !EXCLUDE_FILES(full)) {
      out.push(full);
    }
  }
  return out;
}

const EXPORT_PATTERNS: { regex: RegExp; kind: ExportedSymbol['kind'] }[] = [
  { regex: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm, kind: 'function' },
  { regex: /^export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm, kind: 'class' },
  { regex: /^export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm, kind: 'const' },
  { regex: /^export\s+(?:type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm, kind: 'type' },
];

function extractExports(file: string): ExportedSymbol[] {
  const text = safeReadFile(file, { encoding: 'utf8' }) as string;
  const symbols: ExportedSymbol[] = [];
  for (const { regex, kind } of EXPORT_PATTERNS) {
    let m: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
      const name = m[1];
      // Compute line number of the match
      const upTo = text.slice(0, m.index);
      const line = upTo.split('\n').length;
      symbols.push({ file, name, line, kind });
    }
  }
  return symbols;
}

function countOccurrences(symbol: string, files: string[], excludeFile: string): { external: number; internal: number } {
  // Word-boundary match. Avoid matching inside larger identifiers.
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g');
  let external = 0;
  let internal = 0;
  for (const f of files) {
    let text: string;
    try { text = safeReadFile(f, { encoding: 'utf8' }) as string; } catch { continue; }
    const matches = text.match(re);
    if (!matches) continue;
    if (f === excludeFile) {
      internal += matches.length;
    } else {
      external += matches.length;
    }
  }
  return { external, internal };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  const sourceFiles = SCAN_ROOTS.flatMap(walkTs);
  const allFiles = SEARCH_ROOTS.flatMap(walkAny).filter(p => /\.(ts|js|json|md|yml|yaml)$/.test(p));

  console.log(`🔎 Scanning ${sourceFiles.length} TS source files for dead-code candidates...`);
  console.log(`   Searching across ${allFiles.length} files in libs/scripts/satellites/presence/tests/pipelines/docs.\n`);

  const candidates: DeadCodeCandidate[] = [];
  for (const file of sourceFiles) {
    const relFile = path.relative(ROOT, file);
    if (PUBLIC_API_PATHS.has(relFile)) continue;
    const symbols = extractExports(file);
    for (const sym of symbols) {
      const { external, internal } = countOccurrences(sym.name, allFiles, file);
      if (external === 0) {
        // Record the file relative to project root so the report is portable
        // (no per-developer absolute home paths) and safe to commit.
        candidates.push({
          ...sym,
          file: relFile,
          external_usages: external,
          internal_usages: internal,
        });
      }
    }
  }

  // Group by file for the summary. Candidates already have project-relative paths.
  const byFile = new Map<string, DeadCodeCandidate[]>();
  for (const c of candidates) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }

  console.log(`Found ${candidates.length} candidate symbols across ${byFile.size} files.\n`);

  const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 30);
  for (const [f, syms] of sortedFiles) {
    console.log(`  ${syms.length.toString().padStart(3)}  ${f}`);
    for (const s of syms.slice(0, 5)) {
      console.log(`        ${s.kind.padEnd(8)} ${s.name}  (line ${s.line})`);
    }
    if (syms.length > 5) console.log(`        ... and ${syms.length - 5} more`);
  }
  void sourceFiles; // sourceFiles count is reflected in candidates; suppress unused-warning if any.

  // Write full report
  const reportDir = path.dirname(REPORT_PATH);
  if (!safeExistsSync(reportDir)) safeMkdir(reportDir, { recursive: true });
  safeWriteFile(
    REPORT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        total_candidates: candidates.length,
        files_with_candidates: byFile.size,
        candidates,
        notes: [
          'These are *candidates*, not confirmed dead code.',
          'Verify each by hand before removal. Common false-positive causes:',
          '  - Symbols used only via dynamic imports / require().',
          '  - Symbols referenced from pipelines/*.json or knowledge/*.md (we DO scan these but only as text).',
          '  - Symbols that are part of a public API contract.',
          'Always run `pnpm validate` + integration tests after any deletion.',
        ],
      },
      null,
      2,
    ) + '\n',
    { encoding: 'utf8' },
  );

  console.log(`\n📝 Full report: ${path.relative(ROOT, REPORT_PATH)}`);
  console.log('\n⚠️  This is advisory. Verify each candidate by hand before deleting.');
}

main();
