#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

/**
 * Mass Refactoring Tool for Governance Enforcement
 * Replaces restricted APIs with safe alternatives and manages imports.
 */

function refactorFile(filePath, skillDir) {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // 1. Replace writeFileSync -> safeWriteFile
    if (content.includes('fs.writeFileSync')) {
        content = content.replace(/fs\.writeFileSync\(/g, 'safeWriteFile(');
        modified = true;
    }

    // 2. Ensure safeWriteFile is imported
    if (modified && !content.includes('safeWriteFile')) {
        // This shouldn't happen if we just replaced it, but check for definition
    }

    if (modified && (!content.includes('const { safeWriteFile }') && !content.includes('const {runSkill, safeWriteFile}'))) {
        // Inject import
        const relativePath = path.relative(path.dirname(filePath), path.join(rootDir, 'scripts/lib/secure-io.cjs'));
        const importLine = `const { safeWriteFile } = require('${relativePath}');
`;
        
        // Find best place to inject (after other @agent/core or scripts/lib imports)
        if (content.includes("require('@agent/core')")) {
            content = content.replace(/(const .* = require\('@agent\/core'\);)/, `$1
const { safeWriteFile } = require('${relativePath}');`);
        } else {
            content = importLine + content;
        }
    }

    if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
        return true;
    }
    return false;
}

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'scripts', 'knowledge', 'work', 'templates'].includes(e.name));

let totalRefactored = 0;

skillDirs.forEach(dir => {
    const scriptsPath = path.join(rootDir, dir.name, 'scripts');
    if (!fs.existsSync(scriptsPath)) return;
    
    const files = fs.readdirSync(scriptsPath).filter(f => f.endsWith('.cjs') || f.endsWith('.js'));
    files.forEach(file => {
        if (refactorFile(path.join(scriptsPath, file), dir.name)) {
            console.log(`  [${dir.name}] Refactored: ${file}`);
            totalRefactored++;
        }
    });
});

console.log(`
Refactoring complete. ${totalRefactored} files updated.`);
