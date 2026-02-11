#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { safeJsonParse } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
    .option('url', { alias: 'u', type: 'string', demandOption: true })
    .option('method', { alias: 'm', type: 'string', default: 'GET' })
    .option('headers', { alias: 'H', type: 'string', description: 'JSON string of headers' })
    .option('body', { alias: 'b', type: 'string', description: 'JSON string of body' })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

runAsyncSkill('api-fetcher', async () => {
    // Validate URL format
    try {
        new URL(argv.url);
    } catch (_e) {
        throw new Error(`Invalid URL: ${argv.url}`);
    }

    const config = {
        method: argv.method,
        url: argv.url,
        headers: argv.headers ? safeJsonParse(argv.headers, 'headers') : {},
        data: argv.body ? safeJsonParse(argv.body, 'request body') : undefined,
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024, // 50MB limit
    };

    let response;
    try {
        response = await axios(config);
    } catch (_err) {
        if (err.code === 'ECONNABORTED') {
            throw new Error(`Request timed out after 30s: ${argv.url}`);
        }
        if (err.response) {
            throw new Error(`HTTP ${err.response.status}: ${err.response.statusText}`);
        }
        throw new Error(`Network error: ${err.message}`);
    }

    const data = JSON.stringify(response.data, null, 2);

    if (argv.out) {
        fs.writeFileSync(argv.out, data);
        return { output: argv.out, status: response.status, size: data.length };
    } else {
        return { status: response.status, data: response.data };
    }
});
