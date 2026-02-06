#!/usr/bin/env node

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

