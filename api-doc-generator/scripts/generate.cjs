#!/usr/bin/env node
const fs = require('fs');
const converter = require('widdershins');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

try {
    const openApiStr = fs.readFileSync(argv.input, 'utf8');
    const openApiObj = JSON.parse(openApiStr);
    
    const options = {
        codeSamples: true,
        httpsnippet: false
    };

    converter.convert(openApiObj, options)
        .then(str => {
            fs.writeFileSync(argv.out, str);
            console.log(`Generated API Docs: ${argv.out}`);
        })
        .catch(err => {
            console.error("Conversion failed:", err.message);
            process.exit(1);
        });

} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}