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

    if (modified) {
        // 2. Manage Imports
        const hasSafeImport = content.includes('safeWriteFile');
        const hasCoreImport = content.includes("require('@agent/core')");

        if (!hasSafeImport) {
            const relativePath = path.relative(path.dirname(filePath), path.join(rootDir, 'scripts/lib/secure-io.cjs'));
            
            if (hasCoreImport) {
                // Merge into existing @agent/core require
                content = content.replace(/(const\s+\{\s*)([^}]*)(\s*\}\s*=\s*require\('@agent\/core'\);)/, (m, p1, p2, p3) => {
                    if (p2.includes('safeWriteFile')) return m;
                    const items = p2.split(',').map(i => i.trim()).filter(Boolean);
                    items.push('safeWriteFile');
                    return `${p1}${items.join(', ')}${p3}`;
                });
            } else {
                // Add new separate import, ensuring shebang stays on top
                const importLine = `const { safeWriteFile } = require('${relativePath}');\n`;
                if (content.startsWith('#!')) {
                    content = content.replace(/(^#!.*\n)/, `$1${importLine}`);
                } else {
                    content = importLine + content;
                }
            }
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
