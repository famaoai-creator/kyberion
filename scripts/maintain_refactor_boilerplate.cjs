/**
 * Ecosystem Maintenance: Boilerplate Reducer (Full Sync)
 */
const fs = require('fs');
const path = require('path');
const { walk } = require('./lib/fs-utils.cjs');

const rootDir = path.resolve(__dirname, '..');

async function refactorYargs() {
  console.log('--- Phase 1: Standardizing CLI Options ---');
  for (const filePath of walk(rootDir)) {
    if (!filePath.includes('/scripts/')) continue;
    if (!filePath.endsWith('.cjs')) continue;
    if (filePath.includes('scripts/lib/')) continue;

    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    if (
      content.includes('yargs(hideBin(process.argv))') &&
      !content.includes('createStandardYargs')
    ) {
      console.log(`Refactoring CLI in: ${path.relative(rootDir, filePath)}`);
      if (!content.includes('cli-utils.cjs')) {
        content = content.replace(
          "const { runSkill } = require('@agent/core');",
          "const { runSkill } = require('@agent/core');\nconst { createStandardYargs } = require('@agent/core/cli-utils');"
        );
        content = content.replace(
          "const { runAsyncSkill } = require('@agent/core');",
          "const { runAsyncSkill } = require('@agent/core');\nconst { createStandardYargs } = require('@agent/core/cli-utils');"
        );
      }
      content = content.replace(
        'const argv = yargs(hideBin(process.argv))',
        'const argv = createStandardYargs()'
      );
      content = content.replace(/const yargs = require\('yargs\/yargs'\);\n?/, '');
      content = content.replace(/const { hideBin } = require\('yargs\/helpers'\);\n?/, '');
      modified = true;
    }
    if (modified) fs.writeFileSync(filePath, content);
  }
}

async function refactorFS() {
  console.log('--- Phase 2: Standardizing File Scanning ---');
  for (const filePath of walk(rootDir)) {
    if (!filePath.includes('/scripts/')) continue;
    if (!filePath.endsWith('.cjs')) continue;
    if (filePath.includes('scripts/lib/')) continue;

    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    if (
      content.includes('fs.readdirSync') &&
      (content.includes('currentDepth') ||
        content.includes('recursive') ||
        content.includes('walk'))
    ) {
      if (!content.includes('fs-utils.cjs')) {
        console.log(`Adding fs-utils to: ${path.relative(rootDir, filePath)}`);
        content = content.replace(
          "const { runSkill } = require('@agent/core');",
          "const { runSkill } = require('@agent/core');\nconst { walk, getAllFiles } = require('@agent/core/fs-utils');"
        );
      }
      modified = true;
    }
    if (modified) fs.writeFileSync(filePath, content);
  }
}

async function main() {
  await refactorYargs();
  await refactorFS();
  console.log('Sync complete.');
}

main();
