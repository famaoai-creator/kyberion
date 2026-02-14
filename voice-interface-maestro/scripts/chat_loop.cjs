const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { logger } = require('../../scripts/lib/core.cjs');

// 1. Configuration
const toggleScript = path.resolve(__dirname, '../applescript/toggle_dictation.scpt');
const speakScript = path.resolve(__dirname, 'speak.cjs');
const configPath = path.resolve(__dirname, '../../knowledge/personal/voice/config.json');

let dictationKeycode = 96; // Default to F5 (96)

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.dictationKeycode) dictationKeycode = config.dictationKeycode;
  } catch (_e) {
    logger.warn('Failed to parse voice config. Using default F5 keycode.');
  }
}

function toggleDictation() {
  try {
    execSync(`osascript "${toggleScript}" ${dictationKeycode}`);
  } catch (_e) {
    logger.warn(
      `Failed to toggle dictation (Keycode: ${dictationKeycode}). Check Accessibility permissions.`
    );
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

logger.info(`🤖 Voice Chat Loop Started (Dictation Key: ${dictationKeycode})`);
logger.info('1. Speak your command.');
logger.info('2. Press ENTER to send.');
logger.info('3. Agent will stop dictation, speak, and restart dictation.\n');

// Initial state: Turn ON dictation
toggleDictation();

rl.on('line', (input) => {
  if (!input.trim()) return;

  // 1. User sent message -> Stop Dictation
  toggleDictation();

  // 2. Simulate/Execute
  const responseText = `Received: ${input}`;

  // 3. Agent Speaks (Blocking)
  logger.info(`🗣️  Agent: "${responseText}"`);
  try {
    execSync(`node "${speakScript}" "${responseText}"`);
  } catch (_e) {}

  // 4. Restart Dictation
  setTimeout(() => {
    console.log('\n🎤 Listening... (Start speaking)');
    toggleDictation();
  }, 500);
});
