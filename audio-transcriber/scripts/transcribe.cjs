#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');

const argv = createStandardYargs()
    .option('file', { alias: 'f', type: 'string', demandOption: true })
    .option('key', { alias: 'k', type: 'string', description: 'OpenAI API Key' })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

if (!argv.key && !process.env.OPENAI_API_KEY) {
    console.error("Error: OpenAI API Key required via --key or OPENAI_API_KEY env var.");
    process.exit(1);
}

runAsyncSkill('audio-transcriber', async () => {
    // Validate file exists and check size
    const filePath = path.resolve(argv.file);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Audio file not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
    }
    const maxSize = 25 * 1024 * 1024; // 25MB Whisper API limit
    if (stat.size > maxSize) {
        throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Whisper API limit is 25MB.`);
    }
    if (stat.size === 0) {
        throw new Error('Audio file is empty');
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('model', 'whisper-1');

    const apiKey = argv.key || process.env.OPENAI_API_KEY;

    let response;
    try {
        response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: 120000, // 2 minute timeout for transcription
            maxContentLength: 50 * 1024 * 1024,
        });
    } catch (_err) {
        if (err.code === 'ECONNABORTED') {
            throw new Error('Transcription request timed out after 120s');
        }
        if (err.response) {
            const msg = err.response.data ? JSON.stringify(err.response.data) : err.response.statusText;
            throw new Error(`Whisper API error (${err.response.status}): ${msg}`);
        }
        throw new Error(`Network error: ${err.message}`);
    }

    const text = response.data.text;

    if (argv.out) {
        safeWriteFile(argv.out, text);
        return { output: argv.out, textLength: text.length };
    } else {
        return { text };
    }
});
