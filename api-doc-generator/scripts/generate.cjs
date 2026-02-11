#!/usr/bin/env node
const fs = require('fs');
const converter = require('widdershins');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('out', { alias: 'o', type: 'string', demandOption: true })
    .argv;

runSkill('api-doc-generator', () => {
    const openApiStr = fs.readFileSync(argv.input, 'utf8');
    const openApiObj = JSON.parse(openApiStr);

    const options = {
        codeSamples: true,
        httpsnippet: false
    };

    // Note: converter.convert returns a Promise; using synchronous conversion via deasync-style
    // For now, we write synchronously by blocking on the promise
    let result = null;
    let error = null;
    let done = false;

    converter.convert(openApiObj, options)
        .then(str => {
            fs.writeFileSync(argv.out, str);
            result = { output: argv.out, size: str.length };
            done = true;
        })
        .catch(err => {
            error = err;
            done = true;
        });

    // Busy-wait for the promise to resolve (simple approach for CJS compatibility)
    const start = Date.now();
    while (!done && Date.now() - start < 30000) {
        require('child_process').spawnSync('sleep', ['0.01']);
    }

    if (error) throw error;
    if (!done) throw new Error('Conversion timed out');
    return result;
});
