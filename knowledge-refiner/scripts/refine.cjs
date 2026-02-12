#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
/**
 * knowledge-refiner: Maintains and consolidates the knowledge base.
 * Cleans up duplicates, merges data, and extracts reusable patterns.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { getAllFiles } = require('../../scripts/lib/fs-utils.cjs');

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: 'knowledge', description: 'Knowledge base directory' })
  .option('action', { alias: 'a', type: 'string', default: 'audit', choices: ['audit', 'dedup', 'patterns'], description: 'Refinement action' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function scanKnowledge(dir) {
  const files = [];
  const allFiles = getAllFiles(dir, { maxDepth: 5 });
  for (const full of allFiles) {
    if (['.md', '.json', '.yaml', '.yml', '.txt'].includes(path.extname(full).toLowerCase())) {
      try {
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full, 'utf8');
        files.push({
          path: path.relative(dir, full),
          size: stat.size,
          lines: content.split('\n').length,
          words: content.split(/\s+/).length,
          modified: stat.mtime.toISOString(),
          content
        });
      } catch (_e) {}
    }
  }
  return files;
}

function findDuplicates(files) {
  const duplicates = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      if (files[i].content === files[j].content) {
        duplicates.push({ file1: files[i].path, file2: files[j].path, type: 'exact' });
      } else {
        // Check for high similarity (simple approach: compare word sets)
        const words1 = new Set(files[i].content.toLowerCase().split(/\s+/));
        const words2 = new Set(files[j].content.toLowerCase().split(/\s+/));
        const intersection = [...words1].filter(w => words2.has(w)).length;
        const similarity = intersection / Math.max(words1.size, words2.size);
        if (similarity > 0.8 && words1.size > 20) {
          duplicates.push({ file1: files[i].path, file2: files[j].path, type: 'similar', similarity: Math.round(similarity * 100) });
        }
      }
    }
  }
  return duplicates;
}

function extractPatterns(files) {
  const patterns = {};
  const commonTerms = {};

  for (const file of files) {
    const lower = file.content.toLowerCase();
    // Extract repeated technical terms
    const terms = lower.match(/\b[a-z]{4,}(?:-[a-z]{3,})*\b/g) || [];
    for (const term of terms) {
      commonTerms[term] = (commonTerms[term] || 0) + 1;
    }
    // Extract code patterns
    const codeBlocks = file.content.match(/```[\s\S]*?```/g) || [];
    if (codeBlocks.length > 0) {
      patterns[file.path] = { codeBlocks: codeBlocks.length, hasExamples: true };
    }
  }

  const topTerms = Object.entries(commonTerms).filter(([_t, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([term, count]) => ({ term, occurrences: count }));

  return { topTerms, filesWithCode: Object.keys(patterns).length };
}

function auditQuality(files) {
  const issues = [];
  for (const file of files) {
    if (file.size === 0) issues.push({ file: file.path, issue: 'Empty file', severity: 'high' });
    if (file.words < 10 && file.size > 0) issues.push({ file: file.path, issue: 'Very low content (< 10 words)', severity: 'medium' });
    if (file.lines > 500) issues.push({ file: file.path, issue: `Very large file (${file.lines} lines) - consider splitting`, severity: 'low' });
    if (!file.content.startsWith('#') && file.path.endsWith('.md')) issues.push({ file: file.path, issue: 'Markdown file missing heading', severity: 'low' });
  }
  return issues;
}

runSkill('knowledge-refiner', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);

  const files = scanKnowledge(targetDir);
  const duplicates = findDuplicates(files);
  const quality = auditQuality(files);
  const patterns = extractPatterns(files);

  const result = {
    directory: targetDir, action: argv.action,
    summary: { totalFiles: files.length, totalWords: files.reduce((s, f) => s + f.words, 0), totalLines: files.reduce((s, f) => s + f.lines, 0) },
    duplicates: duplicates.slice(0, 20), duplicateCount: duplicates.length,
    qualityIssues: quality, issueCount: quality.length,
    patterns,
    recommendations: [],
  };

  if (duplicates.length > 0) result.recommendations.push(`${duplicates.length} duplicate(s) found - consider merging`);
  if (quality.filter(q => q.severity === 'high').length > 0) result.recommendations.push('Empty files detected - remove or populate');

  if (argv.out) safeWriteFile(argv.out, JSON.stringify(result, null, 2));
  return result;
});
