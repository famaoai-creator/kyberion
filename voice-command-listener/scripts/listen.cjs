const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const _pathResolver = require('@agent/core/path-resolver');
const { logger } = require('@agent/core/core');

// 1. Configuration
const workDir = path.resolve(__dirname, '../../work/voice_input');
if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
const audioFile = path.join(workDir, 'command.wav');

// 2. Check for SoX
try {
  require('child_process').execSync('sox --version', { stdio: 'ignore' });
} catch (_e) {
  logger.error("SoX not found. Please install it via 'brew install sox'.");
  process.exit(1);
}

logger.info('🎤 Listening... (Press Ctrl+C to stop recording)');

// 3. Record Audio (Sox)
// Records 1 channel, 16k rate, until interrupted.
const record = spawn('rec', ['-c', '1', '-r', '16000', audioFile]);

process.on('SIGINT', () => {
  record.kill();
  logger.success(`\nRecording saved: ${audioFile}`);
  transcribeAndExecute(audioFile);
});

function transcribeAndExecute(_file) {
  logger.info('🧠 Transcribing with OpenAI Whisper...');

  // In a real scenario, we would use 'axios' or 'openai' lib to upload the file.
  // Simulating the API response for this demo.

  const mockTranscriptions = [
    'Run a security audit on the production environment.',
    'Generate a quarterly financial report.',
    'What is the status of the Jira backlog?',
  ];
  const detectedCommand = mockTranscriptions[Math.floor(Math.random() * mockTranscriptions.length)];

  logger.info(`🗣️  Detected Command: "${detectedCommand}"`);
  console.log(`\nTo execute, run: gemini "${detectedCommand}"`);
  process.exit(0);
}
