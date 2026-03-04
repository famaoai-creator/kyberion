/**
 * scripts/redeploy_dist.ts
 * Moves compiled assets to individual skill folders.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';

const rootDir = process.cwd();
const tmpDist = path.join(rootDir, 'dist_tmp/skills');

function findCompiledSkills(baseDir: string, currentRelPath: string = ''): string[] {
  let results: string[] = [];
  if (!fs.existsSync(baseDir)) return results;
  const list = fs.readdirSync(baseDir);
  
  list.forEach(file => {
    const fullPath = path.join(baseDir, file);
    const relPath = path.join(currentRelPath, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      if (fs.existsSync(path.join(fullPath, 'src')) || fs.existsSync(path.join(fullPath, 'scripts'))) {
        results.push(relPath);
      } else {
        results = results.concat(findCompiledSkills(fullPath, relPath));
      }
    }
  });
  return results;
}

async function main() {
  console.log(chalk.bold.cyan('\n📦 Redistributing compiled assets...'));
  const compiledSkills = findCompiledSkills(tmpDist);
  console.log('Found ' + compiledSkills.length + ' compiled skill structures.\n');

  compiledSkills.forEach(relPath => {
    const source = path.join(tmpDist, relPath);
    const target = path.join(rootDir, 'skills', relPath, 'dist');
    
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    
    const candidates = [
      path.join(source, 'src'),
      path.join(source, 'scripts'),
      source
    ];
    
    let filesMoved = 0;
    candidates.forEach(cand => {
      if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
        const files = fs.readdirSync(cand);
        files.forEach(f => {
          if (f.endsWith('.js') || f.endsWith('.map') || f.endsWith('.d.ts')) {
            fs.copyFileSync(path.join(cand, f), path.join(target, f));
            filesMoved++;
          }
        });
      }
    });
    
    if (filesMoved > 0) {
      console.log(chalk.green('✔') + ' Redeployed: ' + relPath + ' (' + filesMoved + ' files)');
    }
  });

  console.log(chalk.bold.cyan('\n✨ Redistribution Complete.\n'));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
