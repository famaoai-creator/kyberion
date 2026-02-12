#!/usr/bin/env node
/**
 * api-doc-generator/scripts/generate.cjs
 * High-Performance Engine: Parallel Extraction & MTime Caching
 */

const fs = require('fs');
const path = require('path');
const { runSkillAsync } = require('@agent/core');
const { requireArgs } = require('@agent/core/validators');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const { Cache } = require('../../scripts/lib/core.cjs');

// Local cache to persist extraction results per file
const extractionCache = new Cache(1000, 86400000); // 24h TTL

runSkillAsync('api-doc-generator', async () => {
    const argv = requireArgs(['dir', 'out']);
    const targetDir = path.resolve(argv.dir);
    const outputPath = path.resolve(argv.out);

    // 1. Load Knowledge (Externalized Patterns)
    const patternsPath = path.resolve(__dirname, '../../knowledge/skills/api-doc-generator/patterns.json');
    const { frameworks } = JSON.parse(fs.readFileSync(patternsPath, 'utf8'));
    const expressPattern = new RegExp(frameworks.express.route_regex, 'g');

    const apiSpecs = {};
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const files = entries
        .filter(e => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.cjs')))
        .map(e => e.name);
    
    // 2. Parallel Extraction with Caching
    const extractionTasks = files.map(async (file) => {
        const filePath = path.join(targetDir, file);
        const stats = fs.statSync(filePath);
        const cacheKey = `${filePath}:${stats.mtimeMs}`;

        if (extractionCache.has(cacheKey)) {
            return { file, specs: extractionCache.get(cacheKey) };
        }

        const content = await fs.promises.readFile(filePath, 'utf8');
        const matches = content.matchAll(expressPattern);
        const localSpecs = [];
        
        for (const match of matches) {
            localSpecs.push({
                method: match[frameworks.express.method_group].toUpperCase(),
                route: match[frameworks.express.path_group]
            });
        }
        
        extractionCache.set(cacheKey, localSpecs);
        return { file, specs: localSpecs };
    });

    const results = await Promise.all(extractionTasks);

    // 3. Aggregate Results
    results.forEach(({ file, specs }) => {
        specs.forEach(({ method, route }) => {
            apiSpecs[`${method} ${route}`] = {
                defined_in: file,
                source_of_truth: 'Reverse Engineered via SCAP/RDP/Parallel'
            };
        });
    });

    // 4. Output as Source of Truth (Text-First)
    const adf = {
        title: "Substantive API Specification",
        generated_at: new Date().toISOString(),
        endpoints: apiSpecs
    };

    safeWriteFile(outputPath, JSON.stringify(adf, null, 2));

    return {
        status: 'success',
        processed_files: files.length,
        extracted_endpoints: Object.keys(apiSpecs).length,
        output: outputPath
    };
});
