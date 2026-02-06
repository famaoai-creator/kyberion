#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('query', { alias: 'q', type: 'string', demandOption: true })
    .option('type', { alias: 't', type: 'string', default: 'all' })
    .argv;

const KNOWLEDGE_BASE = path.join(process.cwd(), 'knowledge');

try {
    function searchFiles(dir, query, results = []) {
        if (!fs.existsSync(dir)) return results;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                searchFiles(fullPath, query, results);
            } else {
                const content = fs.readFileSync(fullPath, 'utf8');
                if (file.includes(query) || content.includes(query)) {
                    results.push({ path: fullPath, content: content });
                }
            }
        }
        return results;
    }

    const targetDir = argv.type === 'all' ? KNOWLEDGE_BASE : path.join(KNOWLEDGE_BASE, argv.type);
    const hits = searchFiles(targetDir, argv.query);
    console.log(JSON.stringify(hits, null, 2));

} catch (e) { console.error(JSON.stringify({ error: e.message })); }
