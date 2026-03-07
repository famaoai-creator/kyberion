/**
 * scripts/build_all_skills.ts
 * Parallel compilation of all TypeScript skills.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import chalk from 'chalk';

const rootDir = process.cwd();

function findTsSkills(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.lstatSync(fullPath);
    if (stat.isDirectory()) {
      if (fs.existsSync(path.join(fullPath, 'tsconfig.json')) && fs.existsSync(path.join(fullPath, 'package.json'))) {
        results.push(fullPath);
      } else {
        results = results.concat(findTsSkills(fullPath));
      }
    }
  });
  return results;
}

async function buildSkill(skillPath: string): Promise<{ path: string; success: boolean }> {
  const relativePath = path.relative(rootDir, skillPath);
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: skillPath,
      stdio: 'ignore',
      shell: true // Required for npm on some systems
    });

    child.on('exit', (code) => {
      if (code === 0) {
        console.log(chalk.green('✔') + ' Built: ' + relativePath);
        resolve({ path: relativePath, success: true });
      } else {
        console.error(chalk.red('✘') + ' Failed: ' + relativePath);
        resolve({ path: relativePath, success: false });
      }
    });
  });
}

async function main() {
  console.log(chalk.bold.cyan('\n🏗️ Starting The Great Rebuild (TS)...\n'));
  const skills = findTsSkills(path.join(rootDir, 'skills'));
  console.log('Found ' + skills.length + ' TypeScript skills to build.\n');

  const startTime = Date.now();
  const results: any[] = [];
  const concurrency = 8;

  for (let i = 0; i < skills.length; i += concurrency) {
    const chunk = skills.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(buildSkill));
    results.push(...chunkResults);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const failed = results.filter(r => !r.success);

  console.log(chalk.bold.cyan('\n✨ Rebuild Complete in ' + duration + 's'));
  console.log('Total: ' + results.length + ' | ' + chalk.green('Success: ' + (results.length - failed.length)) + ' | ' + chalk.red('Failed: ' + failed.length));

  if (failed.length > 0) {
    console.log(chalk.red('\nFailed Skills:'));
    failed.forEach(f => console.log(' - ' + f.path));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
