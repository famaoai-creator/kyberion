import pkg from '@agent/core';
const { logger, runSkillAsync } = pkg as any;
import { createStandardYargs } from '@agent/core/cli-utils';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';

const execAsync = promisify(exec);

/**
 * voice-notifier v1.0
 * High-fidelity voice notification skill.
 */

async function speak(text: string, voice?: string, rate?: number) {
  if (os.platform() !== 'darwin') return;
  const sanitized = text.replace(/"/g, '').replace(/'/g, '');
  let cmd = `say "${sanitized}"`;
  if (voice) cmd += ` -v ${voice}`;
  if (rate) cmd += ` -r ${rate}`;
  await execAsync(cmd);
}

interface NotifierArgs {
  text: string;
  voice?: string;
  rate?: number;
  urgent?: boolean;
}

async function main(args: NotifierArgs) {
  const { text, voice: voiceName, rate, urgent } = args;

  if (!text) {
    logger.error("❌ No text provided for notification.");
    return;
  }

  logger.info(`🗣️ [VoiceNotifier] Speaking: "${text}"`);

  if (urgent) {
    try {
      execSync('afplay /System/Library/Sounds/Glass.aiff');
    } catch (_) {}
  }

  try {
    await speak(text, voiceName, rate);
    
    return {
      status: 'success',
      text: text,
      metadata: {
        voice: voiceName || 'default',
        rate: rate || 'default'
      }
    };
  } catch (err: any) {
    logger.error(`❌ [VoiceNotifier] Failed: ${err.message}`);
    throw err;
  }
}

const argv = createStandardYargs()
  .option('text', { type: 'string', alias: 't', demandOption: true })
  .option('voice', { type: 'string', alias: 'v' })
  .option('rate', { type: 'number', alias: 'r' })
  .option('urgent', { type: 'boolean', alias: 'u', default: false })
  .parseSync();

runSkillAsync('voice-notifier', () => main(argv as any));
