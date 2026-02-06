#!/usr/bin/env node
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('file', { alias: 'f', type: 'string', demandOption: true })
    .option('key', { alias: 'k', type: 'string', description: 'OpenAI API Key' })
    .option('out', { alias: 'o', type: 'string' })
    .argv;

(async () => {
    if (!argv.key && !process.env.OPENAI_API_KEY) {
        console.error("Error: OpenAI API Key required via --key or OPENAI_API_KEY env var.");
        process.exit(1);
    }

    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(argv.file));
        formData.append('model', 'whisper-1');

        const apiKey = argv.key || process.env.OPENAI_API_KEY;

        console.log("Transcribing...");
        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${apiKey}`
            }
        });

        const text = response.data.text;

        if (argv.out) {
            fs.writeFileSync(argv.out, text);
            console.log(`Transcribed text to: ${argv.out}`);
        } else {
            console.log(text);
        }

    } catch (e) {
        console.error("Transcribe Error:", e.message);
        if (e.response) {
            console.error(e.response.data);
        }
        process.exit(1);
    }
})();