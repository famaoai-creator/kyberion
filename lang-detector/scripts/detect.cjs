#!/usr/bin/env node
const fs = require('fs');
const LanguageDetect = require('languagedetect');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const lngDetector = new LanguageDetect();
const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .argv;

try {
    const content = fs.readFileSync(argv.input, 'utf8');
    const results = lngDetector.detect(content, 1);
    
    if (results.length > 0) {
        console.log(JSON.stringify({ language: results[0][0], confidence: results[0][1] }));
    } else {
        console.log(JSON.stringify({ language: 'unknown', confidence: 0 }));
    }
} catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
}