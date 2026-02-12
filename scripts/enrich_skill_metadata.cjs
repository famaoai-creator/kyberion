#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const rootDir = path.resolve(__dirname, '..');

const CATEGORY_MAP = [
    { pattern: /-connector|-fetcher|-integrator|browser-navigator|box-connector|slack-communicator/, cat: 'Integration & API' },
    { pattern: /-auditor|-check|-sentinel|security-scanner|compliance-officer|license-auditor|tier-guard|ip-strategist/, cat: 'Governance & Security' },
    { pattern: /-maestro|-planner|-strategist|-architect|business-growth-planner|north-star-guardian|executive-reporting/, cat: 'Strategy & Leadership' },
    { pattern: /-transformer|-artisan|-composer|-renderer|-curator|word-artisan|excel-artisan|pdf-composer/, cat: 'Data & Content' },
    { pattern: /-engine|-mapper|-scorer|-predictor|-wizard|codebase-mapper|dependency-grapher|test-genie/, cat: 'Engineering & DevOps' },
    { pattern: /voice-|audio-|biometric-/, cat: 'Interface & AI' }
];

function inferCategory(name) {
    for (const { pattern, cat } of CATEGORY_MAP) {
        if (pattern.test(name)) return cat;
    }
    return 'Utilities';
}

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries
    .filter(e => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'SKILL.md')))
    .map(e => e.name);

console.log(`Enriching metadata for ${skillDirs.length} skills...`);

skillDirs.forEach(dir => {
    const skillMdPath = path.join(rootDir, dir, 'SKILL.md');
    let content = fs.readFileSync(skillMdPath, 'utf8');
    // Use multi-line flag and safer matching
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
    if (!fmMatch) return;

    try {
        const fm = yaml.load(fmMatch[1]);
        if (!fm.category || fm.category === 'General') {
            fm.category = inferCategory(dir);
            const newFm = `---\n${yaml.dump(fm)}---`;
            const newContent = content.replace(/^---\n[\s\S]*?\n---/m, newFm);
            if (newContent !== content) {
                fs.writeFileSync(skillMdPath, newContent);
                console.log(`  [${dir}] Category enriched: -> ${fm.category}`);
            }
        }
    } catch (err) {
        console.error(`Failed to enrich ${dir}: ${err.message}`);
    }
});

console.log('Enrichment complete.');
