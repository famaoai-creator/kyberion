const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('../../scripts/lib/core.cjs');

// 1. Load Secure Configuration
const configPath = path.resolve(__dirname, '../../knowledge/personal/voice/config.json');
let config = { engine: 'macos', voice: 'Kyoko', apiKey: null }; // Default to local macos

if (fs.existsSync(configPath)) {
    try {
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config = { ...config, ...userConfig };
    } catch (e) {
        logger.warn('Failed to parse voice config. Using defaults.');
    }
}

// 2. Process Input Text
const textToSpeak = process.argv[2];
if (!textToSpeak) {
    logger.error('Usage: node speak.cjs "Text to speak"');
    process.exit(1);
}

const cleanText = textToSpeak.replace(/```[\s\S]*?```/g, ' [コードをスキップ] ');

// 3. Execution
if (config.engine === 'macos') {
    logger.info(`Using macOS native voice: ${config.voice}`);
    try {
        execSync(`say -v ${config.voice} "${cleanText}"`);
        logger.success('Spoken via macOS say command.');
    } catch (e) {
        logger.error('macOS say command failed. Is this a Mac?');
    }
} else {
    // Fallback/Simulated API (OpenAI/ElevenLabs)
    logger.info(`Using external API engine: ${config.engine}`);
    console.log(`(Simulation) API Voice (${config.voice}) says: "${cleanText}"`);
}