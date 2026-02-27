import path from 'path';
import { fileURLToPath } from 'url';
import { runAsyncSkill } from '@agent/core';
import { logger } from '@agent/core/core';
import { checkSoXInstalled, startRecording, transcribeMock, VoiceListenerOptions } from './lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!checkSoXInstalled()) {
  logger.error("SoX not found. Please install it via 'brew install sox'.");
  process.exit(1);
}

const workDir = path.resolve(__dirname, '../../work/voice_input');
const audioFile = path.join(workDir, 'command.wav');
const options: VoiceListenerOptions = { workDir, audioFile };

logger.info('🎤 Listening... (Press Ctrl+C to stop recording)');

const recordProcess = startRecording(options);

process.on('SIGINT', async () => {
  recordProcess.kill();
  logger.success(`
Recording saved: ${audioFile}`);

  runAsyncSkill('voice-command-listener', async () => {
    logger.info('🧠 Transcribing...');
    const command = await transcribeMock(audioFile);

    logger.info(`🗣️  Detected Command: "${command}"`);
    console.log(`
To execute, run: gemini "${command}"`);

    return { audioFile, command };
  }).then(() => process.exit(0));
});
