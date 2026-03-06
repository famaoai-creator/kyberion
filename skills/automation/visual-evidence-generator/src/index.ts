import { logger, runSkillAsync } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Jimp from 'jimp';
import GIFEncoder from 'gif-encoder-2';

/**
 * visual-evidence-generator v1.0
 * Compiles the frame buffer into an animated GIF.
 */

const STATE_FILE = path.join(process.cwd(), 'active/shared/runtime/vision/buffer-state.json');
const FRAMES_DIR = path.join(process.cwd(), 'active/shared/runtime/vision/frames');
const OUTPUT_DIR = path.join(process.cwd(), 'active/shared/captures');

interface EvidenceArgs {
  output?: string;
  delay?: number;
}

async function createGif(outputPath: string, delay: number) {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error('No buffer state found. Is visual-buffer-daemon running?');
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
  encoder.setRepeat(0);   // 0 for repeat, -1 for no-repeat
  encoder.setDelay(delay); // frame delay in ms
  encoder.setQuality(10); // image quality. 10 is default.

  const outStream = fs.createWriteStream(outputPath);
  encoder.createReadStream().pipe(outStream);

  for (const frameInfo of frames) {
    const framePath = path.join(FRAMES_DIR, frameInfo.file);
    if (!fs.existsSync(framePath)) continue;

    const img = await Jimp.read(framePath);
    
    // Future: Add markers here using Jimp (e.g., img.circle(...))
    // For now, just add a timestamp overlay
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    img.print(font, 10, 10, frameInfo.ts);

    encoder.addFrame(img.bitmap.data);
    logger.info(`   Added frame: ${frameInfo.file}`);
  }

  encoder.finish();
  
  return new Promise((resolve, reject) => {
    outStream.on('finish', resolve);
    outStream.on('error', reject);
  });
}

const main = async (args: EvidenceArgs) => {
  const outputPath = args.output || path.join(OUTPUT_DIR, `evidence-${Date.now()}.gif`);
  const delay = args.delay || 500;

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

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
