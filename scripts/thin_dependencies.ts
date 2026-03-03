import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const rootPkgRaw = safeReadFile(path.join(rootDir, 'package.json'), { encoding: 'utf8' }) as string;
const rootPkg = JSON.parse(rootPkgRaw);

// Common packages we want to hoist to root
const COMMON = Object.keys({
  ...rootPkg.dependencies,
  ...rootPkg.devDependencies,
});

// Dynamically discover skills within namespaces
const skills: { name: string; path: string }[] = [];
const skillsRootDir = path.join(rootDir, 'skills');

if (fs.existsSync(skillsRootDir)) {
  const categories = fs
    .readdirSync(skillsRootDir)
    .filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
  
  for (const cat of categories) {
    const catPath = path.join(skillsRootDir, cat);
    const skillDirs = fs
      .readdirSync(catPath)
      .filter((f) => fs.lstatSync(path.join(catPath, f)).isDirectory());
    
    for (const dir of skillDirs) {
      skills.push({ name: dir, path: path.join('skills', cat, dir) });
    }
  }
}

let totalRemoved = 0;

console.log(`Thinning dependencies for ${skills.length} skills...`);

skills.forEach((skillObj) => {
  const pkgPath = path.join(rootDir, skillObj.path, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  let modified = false;

  if (pkg.dependencies) {
    for (const dep of COMMON) {
      if (pkg.dependencies[dep]) {
        console.log(`  [${skillObj.name}] Removing redundant dependency: ${dep}`);
        delete pkg.dependencies[dep];
        totalRemoved++;
        modified = true;
      }
    }
    // If dependencies object is empty, remove it
    if (Object.keys(pkg.dependencies).length === 0) {
      delete pkg.dependencies;
    }
  }

  if (modified) {
    safeWriteFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
});

console.log(`Thinning complete. Removed ${totalRemoved} redundant dependency declarations.`);
