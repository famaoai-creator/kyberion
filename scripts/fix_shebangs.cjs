#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'scripts', 'knowledge', 'work', 'templates'].includes(e.name));

skillDirs.forEach(dir => {
    const scriptsPath = path.join(rootDir, dir.name, 'scripts');
    if (!fs.existsSync(scriptsPath)) return;
    
    const files = fs.readdirSync(scriptsPath).filter(f => f.endsWith('.cjs') || f.endsWith('.js'));
    files.forEach(file => {
        const filePath = path.join(scriptsPath, file);
        const content = fs.readFileSync(filePath, 'utf8');
        
        if (content.includes('#!/usr/bin/env node') && !content.startsWith('#!')) {
            console.log(`  [${dir.name}] Fixing Shebang position: ${file}`);
            const lines = content.split("\n");
            const shebangIdx = lines.findIndex(l => l.startsWith('#!'));
            const shebangLine = lines[shebangIdx];
            lines.splice(shebangIdx, 1);
            fs.writeFileSync(filePath, shebangLine + "\n" + lines.join("\n"), 'utf8');
        }
    });
});

console.log('Shebang fix complete.');
