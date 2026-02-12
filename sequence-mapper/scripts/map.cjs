#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

runSkill('sequence-mapper', () => {
    const content = fs.readFileSync(argv.input, 'utf8');
    const lines = content.split('\n');

    let mermaid = 'sequenceDiagram\n    autonumber\n';
    let currentFunction = 'Main';

    // Very naive regex-based parser for demonstration
    // Looks for "function X()" and "X()" calls

    lines.forEach(line => {
        const funcDef = line.match(/function\s+(\w+)/);
        if (funcDef) {
            currentFunction = funcDef[1];
        }

        const call = line.match(/(\w+)\(/);
        if (call && !line.includes('function') && call[1] !== 'if' && call[1] !== 'for') {
            const target = call[1];
            mermaid += `    ${currentFunction}->>${target}: ${target}()\n`;
        }
    });

    if (argv.out) {
        safeWriteFile(argv.out, mermaid);
        return { output: argv.out, size: mermaid.length };
    } else {
        return { content: mermaid };
    }
});
