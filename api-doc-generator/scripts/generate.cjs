#!/usr/bin/env node
/**
 * api-doc-generator/scripts/generate.cjs
 * Pure Engine: Decoupled Reverse Design
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@gemini/core');
const { requireArgs } = require('@gemini/core/validators');

runSkill('api-doc-generator', () => {
    const argv = requireArgs(['dir', 'out']);
    const targetDir = path.resolve(argv.dir);
    const outputPath = path.resolve(argv.out);

    // 1. Load Knowledge (Externalized Patterns)
    const patternsPath = path.resolve(__dirname, '../../knowledge/skills/api-doc-generator/patterns.json');
    const { frameworks } = JSON.parse(fs.readFileSync(patternsPath, 'utf8'));
    const expressPattern = new RegExp(frameworks.express.route_regex, 'g');

    const apiSpecs = {};
    const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.js') || f.endsWith('.cjs'));
    
    // 2. Systematic Extraction (RDP Implementation)
    files.forEach(file => {
        const content = fs.readFileSync(path.join(targetDir, file), 'utf8');
        const matches = content.matchAll(expressPattern);
        for (const match of matches) {
            const method = match[frameworks.express.method_group].toUpperCase();
            const route = match[frameworks.express.path_group];
            apiSpecs[`${method} ${route}`] = {
                defined_in: file,
                source_of_truth: 'Reverse Engineered via SCAP/RDP'
            };
        }
    });

    // 3. Output as Source of Truth (Text-First)
    const adf = {
        title: "Substantive API Specification",
        generated_at: new Date().toISOString(),
        endpoints: apiSpecs
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(adf, null, 2));

    return {
        status: 'success',
        extracted_endpoints: Object.keys(apiSpecs).length,
        output: outputPath
    };
});
