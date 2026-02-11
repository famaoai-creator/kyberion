const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = process.cwd();

// Helper to write file safely
function write(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    console.log(`Updated: ${path.relative(rootDir, filePath)}`);
}

// Helper to scaffold skill
function scaffoldSkill(name, desc, scriptName, scriptContent, deps = 'yargs') {
    const skillDir = path.join(rootDir, name);
    const scriptsDir = path.join(skillDir, 'scripts');

    if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });

    // SKILL.md
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `--- 
name: ${name}
description: ${desc}
--- 
# ${name}
${desc}
## Usage
\`\`\`bash
node ${name}/scripts/${scriptName} --input <file>
\`\`\`
`);

    // package.json
    fs.writeFileSync(path.join(skillDir, 'package.json'), JSON.stringify({
        name: name,
        version: "0.1.0",
        description: desc,
        main: `scripts/${scriptName}`,
        dependencies: {}
    }, null, 2));

    // Script
    fs.writeFileSync(path.join(scriptsDir, scriptName), `#!/usr/bin/env node
${scriptContent}
`);
    fs.chmodSync(path.join(scriptsDir, scriptName), '755');

    // Install deps
    if (deps) {
        try { execSync(`npm install ${deps}`, { cwd: skillDir, stdio: 'ignore' }); } catch(e) {}
    }
    
    // Install skill
    try { execSync(`gemini skills install ${name} --scope workspace --consent`, { stdio: 'ignore' }); } catch(e) {}
    console.log(`✅ Created & Installed: ${name}`);
}

console.log("=== Implementing Batch 5: Classifiers ===\n");

// 1. code-lang-detector
scaffoldSkill('code-lang-detector', 'Detect programming language of source code.', 'detect.cjs', `
const fs = require('fs');

const argv = createStandardYargs().option('input', { alias: 'i', type: 'string' }).argv;

const EXT_MAP = {
    '.js': 'javascript', '.ts': 'typescript', '.py': 'python', '.java': 'java', 
    '.c': 'c', '.cpp': 'cpp', '.rs': 'rust', '.go': 'go', '.rb': 'ruby',
    '.php': 'php', '.html': 'html', '.css': 'css', '.sql': 'sql', '.json': 'json',
    '.md': 'markdown', '.sh': 'shell'
};

const KEYWORDS = {
    'python': ['def ', 'import ', 'print('],
    'javascript': ['const ', 'function ', 'console.log'],
    'java': ['public class ', 'System.out.println'],
    'go': ['package main', 'fmt.Println'],
    'rust': ['fn main', 'println!']
};

try {
    const input = argv.input;
    const content = fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : input;
    
    // 1. Extension check
    const ext = require('path').extname(input).toLowerCase();
    if (EXT_MAP[ext]) {
        console.log(JSON.stringify({ lang: EXT_MAP[ext], confidence: 1.0, method: 'extension' }));
        process.exit(0);
    }

    // 2. Keyword check
    let bestLang = 'unknown';
    let maxScore = 0;
    
    for (const [lang, words] of Object.entries(KEYWORDS)) {
        let score = 0;
        words.forEach(w => { if (content.includes(w)) score++; });
        if (score > maxScore) {
            maxScore = score;
            bestLang = lang;
        }
    }
    
    console.log(JSON.stringify({ lang: bestLang, confidence: maxScore > 0 ? 0.8 : 0, method: 'keyword' }));

} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);

// 2. doc-type-classifier
scaffoldSkill('doc-type-classifier', 'Classify document type (meeting-notes, spec, etc).', 'classify.cjs', `
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv)).option('input', { alias: 'i', type: 'string' }).argv;

const RULES = {
    'meeting-notes': ['議事録', '参加者', '決定事項', 'Next Action', 'Agenda'],
    'specification': ['仕様書', '設計', 'Architecture', 'Sequence', 'API Definition'],
    'report': ['報告書', '月次', '週報', 'Report', 'Summary'],
    'contract': ['契約書', '甲', '乙', '条', 'Agreement']
};

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    let bestType = 'unknown';
    let maxScore = 0;

    for (const [type, keywords] of Object.entries(RULES)) {
        let score = 0;
        keywords.forEach(w => { if (content.includes(w)) score++; });
        if (score > maxScore) {
            maxScore = score;
            bestType = type;
        }
    }

    console.log(JSON.stringify({ type: bestType, confidence: maxScore / 5, matches: maxScore }));
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);

// 3. intent-classifier
scaffoldSkill('intent-classifier', 'Classify intent of text (request, question, report).', 'classify.cjs', `
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).option('input', { alias: 'i', type: 'string' }).argv;

const INTENTS = {
    'request': ['依頼', 'お願いします', 'やってください', 'Request'],
    'question': ['?', '？', '教えて', 'とは', 'Question'],
    'report': ['完了', '報告', 'しました', 'Done'],
    'proposal': ['提案', 'どうでしょうか', 'Proposal']
};

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    let bestIntent = 'unknown';
    let maxScore = 0;

    for (const [intent, keywords] of Object.entries(INTENTS)) {
        let score = 0;
        keywords.forEach(w => { if (content.includes(w)) score++; });
        if (score > maxScore) { maxScore = score; bestIntent = intent; }
    }
    console.log(JSON.stringify({ intent: bestIntent, confidence: maxScore > 0 ? 0.7 : 0 }));
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);

// 4. domain-classifier
scaffoldSkill('domain-classifier', 'Classify domain (tech, finance, legal).', 'classify.cjs', `
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).option('input', { alias: 'i', type: 'string' }).argv;

const DOMAINS = {
    'tech': ['API', 'Server', 'Code', 'Bug', 'Deploy'],
    'finance': ['予算', '売上', 'コスト', 'Profit', 'Budget'],
    'legal': ['契約', '条項', 'コンプライアンス', 'License', 'Law'],
    'hr': ['採用', '面接', '給与', 'Hiring', 'Salary']
};

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    let bestDomain = 'unknown';
    let maxScore = 0;

    for (const [domain, keywords] of Object.entries(DOMAINS)) {
        let score = 0;
        keywords.forEach(w => { if (content.includes(w)) score++; });
        if (score > maxScore) { maxScore = score; bestDomain = domain; }
    }
    console.log(JSON.stringify({ domain: bestDomain, confidence: maxScore > 0 ? 0.6 : 0 }));
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);

// 5. quality-scorer
scaffoldSkill('quality-scorer', 'Score text quality (readability, length).', 'score.cjs', `
const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).option('input', { alias: 'i', type: 'string' }).argv;

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    
    // Metrics
    const charCount = content.length;
    const lines = content.split('\n').length;
    const sentences = content.split(/[.?!。？！]/).length;
    
    // Heuristic scoring (0-100)
    let score = 100;
    const issues = [];

    if (charCount < 50) { score -= 20; issues.push('Too short'); }
    if (charCount > 10000) { score -= 10; issues.push('Very long'); }
    
    // Avg sentence length
    const avgLen = charCount / sentences;
    if (avgLen > 100) { score -= 10; issues.push('Sentences are too long on average'); }

    console.log(JSON.stringify({ score, metrics: { charCount, lines, avgLen }, issues }));
} catch (e) { console.error(JSON.stringify({ error: e.message })); }
`);
