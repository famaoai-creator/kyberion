#!/usr/bin/env node

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

