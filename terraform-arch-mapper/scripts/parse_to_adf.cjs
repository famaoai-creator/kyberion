#!/usr/bin/env node
/**
 * terraform-arch-mapper/scripts/parse_to_adf.cjs
 * Parses Terraform into Gemini ADF (JSON).
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');

runSkill('terraform-arch-mapper', () => {
    const dirIdx = process.argv.indexOf('--dir');
    const tfDir = dirIdx !== -1 ? path.resolve(process.argv[dirIdx + 1]) : '.';
    
    const files = fs.readdirSync(tfDir).filter(f => f.endsWith('.tf'));
    const nodes = [];
    const edges = [];

    files.forEach(file => {
        const content = fs.readFileSync(path.join(tfDir, file), 'utf8');
        
        // Extract resources
        const resourceMatches = content.matchAll(/resource\s+"([^"]+)"\s+"([^"]+)"\s+\{([\s\S]*?)\}/g);
        for (const match of resourceMatches) {
            const type = match[1];
            const name = match[2];
            const body = match[3];
            const id = `${type}.${name}`;

            nodes.push({ id, type, name });

            // Extract dependencies (simple version)
            const depMatches = body.matchAll(/[\s=]+(aws_[a-z0-9_]+\.[a-z0-9_]+)/g);
            for (const dep of depMatches) {
                edges.push({ from: id, to: dep[1] });
            }
        }
    });

    const adf = { nodes, edges };
    const outPath = 'work/infrastructure.adf.json';
    safeWriteFile(outPath, JSON.stringify(adf, null, 2));

    return { 
        status: 'success', 
        message: 'ADF generated for AI consumption',
        outputPath: outPath,
        adf
    };
});
