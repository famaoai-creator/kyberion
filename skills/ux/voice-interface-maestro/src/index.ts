import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runSkill } from '@agent/core';
import { logger } from '@agent/core/core';
import { loadVoiceConfig, speakText } from './lib.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = yargs(hideBin(process.argv))
  .option('text', {
    alias: 't',
    type: 'string',
    demandOption: true,
    description: 'Text to speak',
  })
  .parseSync();

runSkill('voice-interface-maestro', () => {
  const configPath = path.resolve(__dirname, '../../../knowledge/personal/voice/config.json');
  const config = loadVoiceConfig(configPath);

  logger.info(`Maestro initialized. Engine: ${config.engine}, Voice: ${config.voice}`);

  const result = speakText(argv.text as string, config);

  if (result.success) {
    logger.success(`Spoken successfully via ${result.method}`);
  } else {
    logger.error(`Failed to speak via ${result.method}`);
  }

  return { ...result, textLength: (argv.text as string).length };
});
