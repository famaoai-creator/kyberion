#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

/**
 * Unused Dependency Detector
 * Scans skill scripts to verify if declared dependencies are actually used.
 */

function isUsed(dep, scriptsDir) {
  if (!fs.existsSync(scriptsDir)) return true; // Assume used if no scripts to check
  const files = fs
    .readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.ts'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    // Check for require('dep') or from 'dep'
    const requireRegex = new RegExp('require\\([\'"]' + dep + '[\'"\/]', 'g');
    const importRegex = new RegExp('from\\s+[\'"]' + dep + '[\'"\/]', 'g');
    if (requireRegex.test(content) || importRegex.test(content)) return true;
  }
  return false;
}

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries.filter(
  (e) =>
    e.isDirectory() &&
    fs.existsSync(path.join(rootDir, e.name, 'package.json')) &&
    !e.name.startsWith('.') &&
    e.name !== 'scripts' &&
    e.name !== 'node_modules'
);

let totalUnused = 0;
const IGNORE_DEPS = ['@agent/core', 'chalk', 'yargs'];

console.log(`Scanning ${skillDirs.length} skills for unused dependencies...`);

skillDirs.forEach((dir) => {
  const pkgPath = path.join(rootDir, dir.name, 'package.json');
  let pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const scriptsDir = path.join(rootDir, dir.name, 'scripts');
  let modified = false;

  if (pkg.dependencies) {
    for (const dep of Object.keys(pkg.dependencies)) {
      if (IGNORE_DEPS.includes(dep)) continue;

      if (!isUsed(dep, scriptsDir)) {
        console.log(`  [${dir.name}] UNUSED: ${dep}`);
        delete pkg.dependencies[dep];
        totalUnused++;
        modified = true;
      }
    }
    if (Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies;
  }

  if (modified) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
});

console.log(`\nScan complete. Removed ${totalUnused} unused dependency declarations.`);
