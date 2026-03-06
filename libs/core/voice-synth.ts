import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import { logger } from './core.js';

const execAsync = promisify(exec);

export interface SpeakOptions {
  voice?: string;
  rate?: number; // Words per minute
}

/**
 * Synthesizes speech using the OS's native TTS capabilities.
 * Currently optimized for macOS 'say' command.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  const platform = os.platform();
  
  if (platform !== 'darwin') {
    logger.warn(`[VoiceSynth] TTS is currently only supported on macOS (darwin). Detected: ${platform}`);
    return;
  }

  // Sanitize text to prevent command injection
  const sanitizedText = text.replace(/"/g, '').replace(/'/g, '');
  
  let command = `say "${sanitizedText}"`;
  
  // Apply options if provided
  if (options.voice) {
    command += ` -v ${options.voice}`;
  }
  if (options.rate) {
    command += ` -r ${options.rate}`;
  }

  try {
    // We don't await here by default to allow non-blocking speech, 
    // unless the caller explicitly wants to wait (we return the promise).
    await execAsync(command);
  } catch (err: any) {
    logger.error(`[VoiceSynth] Failed to speak: ${err.message}`);
  }
}

/**
 * A non-blocking wrapper to trigger speech without awaiting.
 */
export function say(text: string, options: SpeakOptions = {}): void {
  speak(text, options).catch(() => {});
}
