/**
 * scripts/suggest_skill.ts
 * Helps users discover relevant skills based on natural language queries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { safeReadFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

const indexPath = pathResolver.knowledge('orchestration/global_skill_index.json');

export function suggest(query: string) {
  if (!fs.existsSync(indexPath)) return [];
  const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
  const skills = index.s || index.skills || [];

  const searchTerms = query.toLowerCase().split(/[\s-]+/);
  const results: any[] = [];

  skills.forEach((s: any) => {
    const name = (s.n || s.name).toLowerCase();
    const desc = (s.d || s.description || '').toLowerCase();
    let score = 0;

    searchTerms.forEach((term) => {
      if (term.length < 3) return;
      if (name.includes(term)) score += 20;
      if (desc.includes(term)) score += 5;
    });

    if (score > 0) {
      results.push({
        name: s.n || s.name,
        description: s.d || s.description,
        score,
      });
    }
  });

  return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

async function main() {
  const query = process.argv.slice(2).join(' ');
  if (!query) {
    console.log('\nUsage: node suggest_skill.js <your-problem-or-goal>');
    process.exit(0);
  }

  console.log(chalk.cyan(`\n🔍 Searching for skills related to: "${query}"...`));
  const suggestions = suggest(query);

  if (suggestions.length === 0) {
    console.log(chalk.yellow('  No direct matches found. Try using different keywords.'));
  } else {
    console.log(chalk.green(`  Found ${suggestions.length} relevant skills:\n`));
    suggestions.forEach((s) => {
      console.log(`  - ${chalk.bold(s.name.padEnd(25))} ${chalk.dim(s.description)}`);
    });
    console.log(chalk.cyan(`\n  Run: node dist/scripts/cli.js run ${suggestions[0].name} --help`));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
