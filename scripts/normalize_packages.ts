import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const rootPkgRaw = safeReadFile(path.join(rootDir, 'package.json'), { encoding: 'utf8' }) as string;
const rootPkg = JSON.parse(rootPkgRaw);

// Target versions from root package
const TARGET_VERSIONS: Record<string, string> = {
  ...rootPkg.dependencies,
  ...rootPkg.devDependencies,
};

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

console.log(`Normalizing ${skills.length} packages...`);

skills.forEach((skillObj) => {
  const pkgPath = path.join(rootDir, skillObj.path, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  let modified = false;

  // 1. Basic Fields
  if (pkg.private !== true) {
    pkg.private = true;
    modified = true;
  }
  if (pkg.author !== 'Gemini Agent') {
    pkg.author = 'Gemini Agent';
    modified = true;
  }
  if (pkg.license !== 'MIT') {
    pkg.license = 'MIT';
    modified = true;
  }

  // 1.1 Node.js Engine
  if (rootPkg.engines && rootPkg.engines.node) {
    if (!pkg.engines || pkg.engines.node !== rootPkg.engines.node) {
      pkg.engines = { node: rootPkg.engines.node };
      modified = true;
    }
  }

  // 2. Normalize Dependencies
  if (pkg.dependencies) {
    for (const [name, _version] of Object.entries(pkg.dependencies as Record<string, string>)) {
      if (TARGET_VERSIONS[name] && pkg.dependencies[name] !== TARGET_VERSIONS[name]) {
        console.log(
          `  [${skillObj.name}] Updating ${name}: ${pkg.dependencies[name]} -> ${TARGET_VERSIONS[name]}`
        );
        pkg.dependencies[name] = TARGET_VERSIONS[name];
        modified = true;
      }
    }
  }

  // 3. Ensure @agent/core link
  if (!pkg.devDependencies) pkg.devDependencies = {};
  if (pkg.devDependencies['@agent/core'] !== 'workspace:*') {
    pkg.devDependencies['@agent/core'] = 'workspace:*';
    modified = true;
  }

  if (modified) {
    safeWriteFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
});

console.log('Normalization complete.');
