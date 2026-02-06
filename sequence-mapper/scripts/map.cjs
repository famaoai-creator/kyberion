#!/usr/bin/env node
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
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
        fs.writeFileSync(argv.out, mermaid);
        console.log(`Generated Mermaid: ${argv.out}`);
    } else {
        console.log(mermaid);
    }

} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}