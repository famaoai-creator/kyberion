#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

/**
 * Skill Suggestion Engine v1.0
 * Helps users discover relevant skills based on natural language queries.
 */

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

function suggest(query) {
  if (!fs.existsSync(indexPath)) return [];
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const skills = index.s || index.skills;

  // Split query by space or hyphen to handle skill-like-queries
  const searchTerms = query.toLowerCase().split(/[\s-]+/);
  const results = [];

  skills.forEach((s) => {
    const name = (s.n || s.name).toLowerCase();
    const desc = (s.d || s.description || '').toLowerCase();
    let score = 0;

    searchTerms.forEach((term) => {
      if (term.length < 3) return; // Skip too short terms
      if (name.includes(term)) score += 20; // Name matches are high value
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

// CLI usage
if (require.main === module) {
  const query = process.argv.slice(2).join(' ');
  if (!query) {
    console.log(`
Usage: node scripts/suggest_skill.cjs <your-problem-or-goal>`);
    process.exit(0);
  }

  console.log(
    chalk.cyan(`
🔍 Searching for skills related to: "${query}"...`)
  );
  const suggestions = suggest(query);

  if (suggestions.length === 0) {
    console.log(chalk.yellow('  No direct matches found. Try using different keywords.'));
  } else {
    console.log(
      chalk.green(`  Found ${suggestions.length} relevant skills:
`)
    );
    suggestions.forEach((s) => {
      console.log(`  - ${chalk.bold(s.name.padEnd(25))} ${chalk.dim(s.description)}`);
    });
    console.log(
      chalk.cyan(`
  Run: node scripts/cli.cjs run ${suggestions[0].name} --help`)
    );
  }
}

module.exports = { suggest };
