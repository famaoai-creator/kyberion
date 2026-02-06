#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('url', { alias: 'u', type: 'string', demandOption: true })
    .option('method', { alias: 'm', type: 'string', default: 'GET' })
    .option('headers', { alias: 'H', type: 'string', description: 'JSON string of headers' })
    .option('body', { alias: 'b', type: 'string', description: 'JSON string of body' })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

(async () => {
    try {
        const config = {
            method: argv.method,
            url: argv.url,
            headers: argv.headers ? JSON.parse(argv.headers) : {},
            data: argv.body ? JSON.parse(argv.body) : undefined
        };

        const response = await axios(config);
        const data = JSON.stringify(response.data, null, 2);

        if (argv.out) {
            fs.writeFileSync(argv.out, data);
            console.log(`Fetched data to: ${argv.out}`);
        } else {
            console.log(data);
        }
    } catch (e) {
        console.error("Fetch Error:", e.message);
        if (e.response) {
            console.error("Status:", e.response.status);
            console.error("Data:", JSON.stringify(e.response.data));
        }
        process.exit(1);
    }
})();