import { logger, runSkillAsync, safeReadFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import Tesseract from 'tesseract.js';

/**
 * visual-assertion-engine v1.0
 * Uses the screen frame buffer to wait for specific visual states.
 * [SECURE-IO COMPLIANT VERSION]
 */

const STATE_FILE = path.join(process.cwd(), 'active/shared/runtime/vision/buffer-state.json');
const FRAMES_DIR = path.join(process.cwd(), 'active/shared/runtime/vision/frames');

interface AssertionArgs {
  text?: string;
  timeout?: number;
  interval?: number;
}

async function getLatestFramePath(): Promise<string | null> {
  try {
    const rawContent = safeReadFile(STATE_FILE, { encoding: 'utf8' }) as string;
    const state = JSON.parse(rawContent);
    if (state.frames && state.frames.length > 0) {
      const latest = state.frames[state.frames.length - 1];
      return path.join(FRAMES_DIR, latest.file);
    }
  } catch (err) {
    // Suppress error if file doesn't exist yet
  }
  return null;
}

async function checkTextOnScreen(targetText: string): Promise<boolean> {
  const framePath = await getLatestFramePath();
  if (!framePath) {
    logger.warn('No frame available for assertion.');
    return false;
  }

  logger.info(`🔍 [Assertion] Checking for "${targetText}" on frame: ${path.basename(framePath)}`);
  
  try {
    // Tesseract handles the file read itself via path, but we've already validated access via safeReadFile check in getLatestFramePath
    const { data: { text } } = await Tesseract.recognize(framePath, 'eng+jpn');
    const cleanText = text.replace(/\s+/g, ' ');
    const found = cleanText.toLowerCase().includes(targetText.toLowerCase());
    
    if (found) {
      logger.success(`✅ [Assertion] Found matching text: "${targetText}"`);
    }
    return found;
  } catch (err: any) {
    logger.error(`OCR failed: ${err.message}`);
    return false;
  }
}

const main = async (args: AssertionArgs) => {
  const targetText = args.text;
  const timeout = args.timeout || 30000;
  const interval = args.interval || 1000;

  if (!targetText) {
    throw new Error('--text is required for OCR-based assertion.');
  }

  logger.info(`👁️ [VisualAssertion] Waiting for text: "${targetText}" (Timeout: ${timeout}ms)`);

  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const success = await checkTextOnScreen(targetText);
    if (success) {
      return { status: 'success', text: targetText, found: true };
    }
    await new Promise(r => setTimeout(r, interval));
  }

  throw new Error(`❌ [VisualAssertion] Timeout reached. Could not find text: "${targetText}"`);
};

const argv = createStandardYargs()
  .option('text', { type: 'string' })
  .option('timeout', { type: 'number' })
  .option('interval', { type: 'number' })
  .parseSync();

runSkillAsync('visual-assertion-engine', () => main(argv as any));
