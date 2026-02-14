#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
  .option('query', { alias: 'q', type: 'string', demandOption: true })
  .option('type', { alias: 't', type: 'string', default: 'all' }).argv;

const KNOWLEDGE_BASE = path.join(process.cwd(), 'knowledge');

const MAX_DEPTH = 10;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB per file
const MAX_RESULTS = 50;

runSkill('knowledge-fetcher', () => {
  function searchFiles(dir, query, results = [], depth = 0) {
    if (depth > MAX_DEPTH) return results;
    if (results.length >= MAX_RESULTS) return results;
    if (!fs.existsSync(dir)) return results;

    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_e) {
      return results;
    }

    for (const file of files) {
      if (results.length >= MAX_RESULTS) break;
      const fullPath = path.join(dir, file);

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (_e) {
        continue;
      }

      if (stat.isDirectory()) {
        searchFiles(fullPath, query, results, depth + 1);
      } else if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (file.includes(query) || content.includes(query)) {
            results.push({ path: fullPath, content: content });
          }
        } catch (_e) {
          // Skip binary or unreadable files
        }
      }
    }
    return results;
  }

  const targetDir = argv.type === 'all' ? KNOWLEDGE_BASE : path.join(KNOWLEDGE_BASE, argv.type);

  if (!fs.existsSync(targetDir)) {
    throw new Error(`Knowledge directory not found: ${targetDir}`);
  }

  const hits = searchFiles(targetDir, argv.query);
  return { query: argv.query, type: argv.type, totalHits: hits.length, results: hits };
});
