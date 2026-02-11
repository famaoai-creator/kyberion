const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = process.cwd();
const knowledgeDir = path.join(rootDir, 'knowledge');

// Helper to scaffold skill (same as before)
function scaffoldSkill(name, desc, scriptName, scriptContent, deps = 'yargs') {
    const skillDir = path.join(rootDir, name);
    const scriptsDir = path.join(skillDir, 'scripts');
    if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `--- 
name: ${name}
description: ${desc}
---
# ${name}
${desc}
## Usage
\
node ${name}/scripts/${scriptName} [options]
\
`);
    fs.writeFileSync(path.join(skillDir, 'package.json'), JSON.stringify({
        name: name, version: "0.1.0", description: desc, main: `scripts/${scriptName}`, dependencies: {}
    }, null, 2));
    fs.writeFileSync(path.join(scriptsDir, scriptName), `#!/usr/bin/env node
${scriptContent}
`);
    fs.chmodSync(path.join(scriptsDir, scriptName), '755');
    if (deps) { try { execSync(`npm install ${deps}`, { cwd: skillDir, stdio: 'ignore' }); } catch(e) {} }
    try { execSync(`gemini skills install ${name} --scope workspace --consent`, { stdio: 'ignore' }); } catch(e) {}
    console.log(`✅ Created & Installed: ${name}`);
}

console.log("=== Implementing Batch 6: Knowledge Layer ===\n");

// 1. Setup Directory Structure
['schemas', 'templates', 'rules', 'glossaries', 'prompts'].forEach(d => {
    fs.mkdirSync(path.join(knowledgeDir, d), { recursive: true });
});

// Create Sample Knowledge
fs.writeFileSync(path.join(knowledgeDir, 'glossaries/tech.json'), JSON.stringify({
    "API": "Application Programming Interface",
    "LLM": "Large Language Model",
    "CLI": "Command Line Interface"
}, null, 2));

fs.writeFileSync(path.join(knowledgeDir, 'templates/report.ejs'), "# Report: {{title}}\n\n{{content}}");
console.log("✅ Knowledge directory structure created.");

// 2. Implement Skills

// knowledge-fetcher
scaffoldSkill('knowledge-fetcher', 'Fetch knowledge from local repository.', 'fetch.cjs', `
const fs = require('fs');
const path = require('path');

const argv = createStandardYargs()
    .option('query', { alias: 'q', type: 'string', demandOption: true })
    .option('type', { alias: 't', type: 'string', default: 'all' }) // schemas, templates, etc.
    .argv;

const KNOWLEDGE_BASE = path.join(process.cwd(), 'knowledge');

try {
    // Simple file search (recursive)
    function searchFiles(dir, query, results = []) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                searchFiles(fullPath, query, results);
            } else {
                if (file.includes(query)) {
                    results.push({ path: fullPath, content: fs.readFileSync(fullPath, 'utf8') });
                }
            }
        }
        return results;
    }

    const targetDir = argv.type === 'all' ? KNOWLEDGE_BASE : path.join(KNOWLEDGE_BASE, argv.type);
    if (!fs.existsSync(targetDir)) throw new Error("Knowledge type not found: " + argv.type);

    const hits = searchFiles(targetDir, argv.query);
    console.log(JSON.stringify(hits, null, 2));

} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);

// context-injector
scaffoldSkill('context-injector', 'Inject knowledge into JSON data context.', 'inject.cjs', `
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('data', { alias: 'd', type: 'string', demandOption: true })
    .option('knowledge', { alias: 'k', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    const data = JSON.parse(fs.readFileSync(argv.data, 'utf8'));
    const knowledgeContent = fs.readFileSync(argv.knowledge, 'utf8');

    // Inject into _context field
    data._context = data._context || {};
    data._context.injected_knowledge = knowledgeContent;

    const output = JSON.stringify(data, null, 2);
    if (argv.out) {
        fs.writeFileSync(argv.out, output);
        console.log("Injected context to: " + argv.out);
    } else {
        console.log(output);
    }
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);

// glossary-resolver
scaffoldSkill('glossary-resolver', 'Resolve terms using glossary.', 'resolve.cjs', `
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('glossary', { alias: 'g', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

try {
    let content = fs.readFileSync(argv.input, 'utf8');
    const glossary = JSON.parse(fs.readFileSync(argv.glossary, 'utf8'));

    // Replace terms with "Term (Definition)"
    for (const [term, def] of Object.entries(glossary)) {
        // Simple string replace, avoiding already defined terms could be complex
        // For MVP: naive replacement
        const regex = new RegExp(`\\b${term}\\b`, 'g');
        content = content.replace(regex, `${term} (${def})`);
    }

    if (argv.out) {
        fs.writeFileSync(argv.out, content);
        console.log("Resolved terms to: " + argv.out);
    } else {
        console.log(content);
    }
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);
