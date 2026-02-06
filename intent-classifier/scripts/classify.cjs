#!/usr/bin/env node

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

