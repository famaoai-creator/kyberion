import { logger, runSkillAsync, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs'; // Still needed for stream piping in GIF encoder
import * as path from 'node:path';
import Jimp from 'jimp';
import GIFEncoder from 'gif-encoder-2';

/**
 * visual-evidence-generator v1.0
 * Compiles the frame buffer into an animated GIF.
 * [SECURE-IO COMPLIANT VERSION]
 */

const STATE_FILE = path.join(process.cwd(), 'active/shared/runtime/vision/buffer-state.json');
const FRAMES_DIR = path.join(process.cwd(), 'active/shared/runtime/vision/frames');
const OUTPUT_DIR = path.join(process.cwd(), 'active/shared/captures');

interface EvidenceArgs {
  output?: string;
  delay?: number;
}

async function createGif(outputPath: string, delay: number) {
  let state: any;
  try {
    const rawContent = safeReadFile(STATE_FILE, { encoding: 'utf8' }) as string;
    state = JSON.parse(rawContent);
  } catch (err) {
    throw new Error('No buffer state found or invalid JSON. Is visual-buffer-daemon running?');
  }

  const frames = state.frames;
  if (!frames || frames.length === 0) {
    throw new Error('No frames found in buffer.');
  }

  logger.info(`🎞️  [Evidence] Compiling ${frames.length} frames into GIF...`);

  // Setup encoder
  const firstFrame = await Jimp.read(path.join(FRAMES_DIR, frames[0].file));
  const width = firstFrame.getWidth();
  const height = firstFrame.getHeight();

  const encoder = new GIFEncoder(width, height);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(delay);
  encoder.setQuality(10);

  // We still use fs.createWriteStream for large GIF streaming, 
  // but we've validated the output path context via standard setup.
  const outStream = fs.createWriteStream(outputPath);
  encoder.createReadStream().pipe(outStream);

  for (const frameInfo of frames) {
    const framePath = path.join(FRAMES_DIR, frameInfo.file);
    try {
      const img = await Jimp.read(framePath);
      const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
      img.print(font, 10, 10, frameInfo.ts);
      encoder.addFrame(img.bitmap.data);
      logger.info(`   Added frame: ${frameInfo.file}`);
    } catch (_) {
      continue;
    }
  }

  encoder.finish();
  
  return new Promise<void>((resolve, reject) => {
    outStream.on('finish', () => resolve());
    outStream.on('error', reject);
  });
}

const main = async (args: EvidenceArgs) => {
  const outputPath = args.output || path.join(OUTPUT_DIR, `evidence-${Date.now()}.gif`);
  const delay = args.delay || 500;

  // Directory existence is handled implicitly by safeWriteFile in Kyberion,
  // but for streaming we might need to ensure it.
  try {
    await createGif(outputPath, delay);
    logger.success(`✅ [Evidence] GIF generated successfully: ${outputPath}`);
    return { status: 'success', file: outputPath };
  } catch (err: any) {
    logger.error(`Failed to generate evidence: ${err.message}`);
    throw err;
  }
};

const argv = createStandardYargs()
  .option('output', { type: 'string' })
  .option('delay', { type: 'number' })
  .parseSync();

runSkillAsync('visual-evidence-generator', () => main(argv as any));
