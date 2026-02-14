#!/usr/bin/env node
/**
 * Migration Script: Migrate skill scripts to use runSkill() from skill-wrapper.cjs
 *
 * Usage:
 *   node scripts/migrate_to_wrapper.cjs           # Dry-run (show what would change)
 *   node scripts/migrate_to_wrapper.cjs --apply    # Actually write changes
 *
 * This script scans all skill scripts and reports their migration status.
 * Actual migrations are done manually per-file using the Write tool,
 * since each file has unique patterns that require careful handling.
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const ROOT = path.resolve(__dirname, '..');
const applyMode = process.argv.includes('--apply');

// --- Skip Lists ---

const INTERACTIVE_SKILLS = [
  'nonfunctional-architect/scripts/assess.cjs',
  'github-skills-manager/scripts/dashboard.cjs',
  'voice-command-listener/scripts/listen.cjs',
  'voice-interface-maestro/scripts/chat_loop.cjs',
  'voice-interface-maestro/scripts/speak.cjs',
];

const MODULE_FILES = [
  'nonfunctional-architect/scripts/iac_analyzer.cjs',
  'github-skills-manager/scripts/git_status.cjs',
];

const SKIP_FILES = [...INTERACTIVE_SKILLS, ...MODULE_FILES];

// --- Find all skill scripts ---

function findSkillScripts() {
  const pattern = '*/scripts/*.cjs';
  const files = glob.sync(pattern, { cwd: ROOT });
  return files.filter((f) => !f.startsWith('scripts/')); // exclude top-level scripts/
}

// --- Detect pattern ---

function detectPattern(content, relativePath) {
  if (content.includes('runSkill') || content.includes('runAsyncSkill')) return 'already-migrated';

  const relPath = relativePath.replace(/\\/g, '/');
  if (SKIP_FILES.includes(relPath)) return 'skip';

  // Async IIFE pattern
  if (
    content.includes('(async ()') ||
    (content.includes('async function') &&
      (content.includes('await ') || content.includes('.then(')))
  ) {
    // Check for async IIFE specifically
    if (content.includes('(async ()') || content.includes('db.serialize')) return 'async';
  }

  // Pattern A: JSON output with try/catch
  if (content.includes('console.log(JSON.stringify(') && content.includes('try {')) {
    if (!content.includes('argv.out') && !content.includes('--out')) return 'pattern-a';
  }

  // Pattern B: File output with optional --out
  if (
    (content.includes('argv.out') || content.includes('argv.o')) &&
    content.includes('fs.writeFileSync')
  ) {
    return 'pattern-b';
  }

  // Pattern C: Text output, no JSON.stringify in main output
  return 'pattern-c';
}

// --- Main ---

function main() {
  console.log(`\n=== Skill Migration Scanner ===`);
  console.log(`Mode: ${applyMode ? 'APPLY' : 'DRY-RUN'}\n`);

  const files = findSkillScripts();
  const results = {
    'already-migrated': [],
    skip: [],
    'pattern-a': [],
    'pattern-b': [],
    'pattern-c': [],
    async: [],
  };

  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const pattern = detectPattern(content, file);
    results[pattern] = results[pattern] || [];
    results[pattern].push(file);
  }

  // Report
  console.log(`Already migrated (${results['already-migrated'].length}):`);
  results['already-migrated'].forEach((f) => console.log(`  [OK] ${f}`));

  console.log(`\nSkipped - interactive/module (${results['skip'].length}):`);
  results['skip'].forEach((f) => console.log(`  [SKIP] ${f}`));

  console.log(`\nPattern A - JSON output (${results['pattern-a'].length}):`);
  results['pattern-a'].forEach((f) => console.log(`  [A] ${f}`));

  console.log(`\nPattern B - File output (${results['pattern-b'].length}):`);
  results['pattern-b'].forEach((f) => console.log(`  [B] ${f}`));

  console.log(`\nPattern C - Text/other output (${results['pattern-c'].length}):`);
  results['pattern-c'].forEach((f) => console.log(`  [C] ${f}`));

  console.log(`\nPattern D - Async (${results['async'].length}):`);
  results['async'].forEach((f) => console.log(`  [D] ${f}`));

  // Summary
  const total = files.length;
  const migrated = results['already-migrated'].length;
  const skipped = results['skip'].length;
  const needMigration = total - migrated - skipped;

  console.log(`\n=== Summary ===`);
  console.log(`Total skill scripts: ${total}`);
  console.log(`Already migrated:    ${migrated}`);
  console.log(`Skipped:             ${skipped}`);
  console.log(`Need migration:      ${needMigration}`);
  console.log(`  Pattern A (JSON):  ${results['pattern-a'].length}`);
  console.log(`  Pattern B (File):  ${results['pattern-b'].length}`);
  console.log(`  Pattern C (Text):  ${results['pattern-c'].length}`);
  console.log(`  Pattern D (Async): ${results['async'].length}`);

  if (!applyMode) {
    console.log(`\nRun with --apply to execute migrations.`);
  }
}

main();
