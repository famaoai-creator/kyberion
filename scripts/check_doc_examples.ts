#!/usr/bin/env node
/**
 * Doc Example Check (Phase C'-6)
 *
 * Walks markdown files under `docs/` and validates fenced code blocks that
 * are tagged for execution. Avoids the "docs say X but X has rotted" problem.
 *
 * Supported tags (the language identifier on the fence):
 *
 *   ```bash check        # `bash check` — runs `bash -c <body>` and asserts exit 0.
 *   ```sh check          # alias for bash check.
 *   ```bash skip         # `bash skip` — known to not work yet, recorded.
 *   ```bash check-syntax # syntax-only validation (`bash -n`).
 *
 * Default behavior (no `check`/`skip` tag): not executed, recorded as
 * "documentation only".
 *
 * The check intentionally stays narrow — it does NOT execute arbitrary code
 * blocks. Maintainers tag specific blocks they want CI to verify.
 *
 * Modes:
 *   pnpm tsx scripts/check_doc_examples.ts          # check
 *   pnpm tsx scripts/check_doc_examples.ts --list   # list all tagged blocks
 *
 * Future: add support for `typescript check` (compiles snippet) and `json check`
 * (validates JSON parse). For now bash only.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir, safeStat } from '@agent/core';

const ROOT = pathResolver.rootDir();
const DOCS_DIRS = [path.join(ROOT, 'docs'), path.join(ROOT, 'README.md')];

interface CodeBlock {
  file: string;
  startLine: number;
  fence: string;        // the language tag, e.g. "bash check"
  body: string;
}

interface BlockResult {
  block: CodeBlock;
  status: 'ok' | 'failed' | 'skipped' | 'not-tagged';
  detail?: string;
}

function listMarkdownFiles(roots: string[]): string[] {
  const out: string[] = [];
  function walk(p: string): void {
    const stat = safeStat(p);
    if (stat.isDirectory()) {
      for (const e of safeReaddir(p)) walk(path.join(p, e));
    } else if (stat.isFile() && p.endsWith('.md')) {
      out.push(p);
    }
  }
  for (const r of roots) {
    if (safeExistsSync(r)) walk(r);
  }
  return out;
}

function parseCodeBlocks(file: string): CodeBlock[] {
  const text = safeReadFile(file, { encoding: 'utf8' }) as string;
  const lines = text.split('\n');
  const blocks: CodeBlock[] = [];
  let inFence = false;
  let fenceText = '';
  let bodyLines: string[] = [];
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence && line.startsWith('```')) {
      inFence = true;
      fenceText = line.slice(3).trim();
      bodyLines = [];
      startLine = i + 1;
    } else if (inFence && line.startsWith('```')) {
      blocks.push({ file, startLine, fence: fenceText, body: bodyLines.join('\n') });
      inFence = false;
    } else if (inFence) {
      bodyLines.push(line);
    }
  }
  return blocks;
}

function runBashCheck(body: string): { ok: boolean; detail: string } {
  const r = spawnSync('bash', ['-c', body], { encoding: 'utf-8', timeout: 30_000 });
  if (r.status === 0) return { ok: true, detail: '' };
  return {
    ok: false,
    detail: `exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 500)}`,
  };
}

function runBashSyntax(body: string): { ok: boolean; detail: string } {
  const r = spawnSync('bash', ['-n'], { input: body, encoding: 'utf-8' });
  if (r.status === 0) return { ok: true, detail: '' };
  return { ok: false, detail: r.stderr.slice(0, 500) };
}

function evaluate(block: CodeBlock): BlockResult {
  const fence = block.fence.toLowerCase();
  if (/^(bash|sh)\s+check$/.test(fence)) {
    const r = runBashCheck(block.body);
    return { block, status: r.ok ? 'ok' : 'failed', detail: r.detail };
  }
  if (/^(bash|sh)\s+check-syntax$/.test(fence)) {
    const r = runBashSyntax(block.body);
    return { block, status: r.ok ? 'ok' : 'failed', detail: r.detail };
  }
  if (/^(bash|sh)\s+skip$/.test(fence)) {
    return { block, status: 'skipped', detail: 'tagged "skip"' };
  }
  return { block, status: 'not-tagged' };
}

function main(): void {
  const args = process.argv.slice(2);
  const listMode = args.includes('--list');
  const files = listMarkdownFiles(DOCS_DIRS);
  const allBlocks = files.flatMap(parseCodeBlocks);

  if (listMode) {
    for (const b of allBlocks) {
      const fence = b.fence || '<empty>';
      const tagged =
        /(bash|sh)\s+(check|check-syntax|skip)$/i.test(fence) ? '🏷' : '  ';
      console.log(`${tagged}  ${path.relative(ROOT, b.file)}:${b.startLine}  [${fence}]`);
    }
    console.log(`\nTotal: ${allBlocks.length} code blocks across ${files.length} markdown files.`);
    return;
  }

  const results = allBlocks.map(evaluate);
  const failed = results.filter(r => r.status === 'failed');
  const ok = results.filter(r => r.status === 'ok').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const notTagged = results.filter(r => r.status === 'not-tagged').length;

  console.log(`📚 Doc example check`);
  console.log(`   Files scanned: ${files.length}`);
  console.log(`   Code blocks:   ${allBlocks.length} (${notTagged} untagged, ${ok} passed, ${skipped} skipped, ${failed.length} failed)`);

  if (failed.length > 0) {
    console.error('\nFailures:');
    for (const f of failed) {
      console.error(`  ❌ ${path.relative(ROOT, f.block.file)}:${f.block.startLine}  [${f.block.fence}]`);
      console.error(`     ${f.detail}`);
    }
    process.exit(1);
  }
  console.log('\n✅ All tagged doc examples passed.');
}

main();
