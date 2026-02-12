#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { requireArgs } = require('../../scripts/lib/validators.cjs');

runSkill('dependency-grapher', () => {
    const args = requireArgs(['dir']);
    const rootDir = path.resolve(args.dir);
    const output = args.out || 'evidence/dependency-map.mmd';

    const items = fs.readdirSync(rootDir);
    let mermaid = 'graph TD\n';
    mermaid += '    subgraph Shared_Library\n';
    mermaid += '        Lib[scripts/lib/]\n';
    mermaid += '    end\n\n';

    let skillCount = 0;

    for (const item of items) {
        const fullPath = path.join(rootDir, item);
        try {
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
                skillCount++;
                const skillId = item.replace(/-/g, '_');
                mermaid += `    ${skillId}[${item}]\n`;

                const scriptsDir = path.join(fullPath, 'scripts');
                if (fs.existsSync(scriptsDir)) {
                    const files = fs.readdirSync(scriptsDir);
                    let usesLib = false;
                    for (const file of files) {
                        if (file.endsWith('.cjs') || file.endsWith('.ts')) {
                            const content = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
                            if (content.includes('../../scripts/lib/')) {
                                usesLib = true;
                                break;
                            }
                        }
                    }
                    if (usesLib) {
                        mermaid += `    ${skillId} --> Lib\n`;
                    }
                }
            }
        } catch (e) {
            // Skip non-accessible files
        }
    }

    safeWriteFile(output, mermaid);
    return { 
        status: 'success', 
        skillsScanned: skillCount, 
        outputPath: output 
    };
});
