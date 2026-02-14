#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

// Target versions from root package
const TARGET_VERSIONS = {
  ...rootPkg.dependencies,
  ...rootPkg.devDependencies,
};

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'package.json')))
  .map((e) => e.name);

console.log(`Normalizing ${skillDirs.length} packages...`);

skillDirs.forEach((dir) => {
  const pkgPath = path.join(rootDir, dir, 'package.json');
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
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (TARGET_VERSIONS[name] && pkg.dependencies[name] !== TARGET_VERSIONS[name]) {
        console.log(
          `  [${dir}] Updating ${name}: ${pkg.dependencies[name]} -> ${TARGET_VERSIONS[name]}`
        );
        pkg.dependencies[name] = TARGET_VERSIONS[name];
        modified = true;
      }
    }
  }

  // 3. Ensure @agent/core link if it's a skill
  if (dir !== 'scripts' && dir !== 'node_modules' && !dir.startsWith('.')) {
    if (!pkg.devDependencies) pkg.devDependencies = {};
    if (pkg.devDependencies['@agent/core'] !== 'workspace:*') {
      pkg.devDependencies['@agent/core'] = 'workspace:*';
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
});

console.log('Normalization complete.');
