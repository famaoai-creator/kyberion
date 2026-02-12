#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

// Common packages we want to hoist to root
const COMMON = Object.keys({
    ...rootPkg.dependencies,
    ...rootPkg.devDependencies
});

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries.filter(e => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'package.json')) && !e.name.startsWith('.') && e.name !== 'scripts' && e.name !== 'node_modules');

let totalRemoved = 0;

console.log(`Thinning dependencies for ${skillDirs.length} skills...`);

skillDirs.forEach(dir => {
    const pkgPath = path.join(rootDir, dir.name, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let modified = false;

    if (pkg.dependencies) {
        for (const dep of COMMON) {
            if (pkg.dependencies[dep]) {
                console.log(`  [${dir.name}] Removing redundant dependency: ${dep}`);
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
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", 'utf8');
    }
});

console.log(`Thinning complete. Removed ${totalRemoved} redundant dependency declarations.`);
