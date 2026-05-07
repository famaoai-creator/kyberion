import { logger, safeReadFile, executeServicePreset, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';

/**
 * Vision-Actuator v1.3.0 [LEGACY COMPATIBILITY FACADE]
 * Preserves legacy visual generation/capture entrypoints while the ecosystem
 * shifts generative workflows toward media-generation-actuator.
 */

const LEGACY_MEDIA_GENERATION_ACTIONS = new Set([
  'generate_image',
  'generate_video',
  'generate_music',
  'capture_screen',
  'record_screen',
  'run_workflow',
]);

async function inspectImage(params: any) {
  const logicalPath = String(params.path || '');
  if (!logicalPath) throw new Error('inspect_image requires params.path');
  const buffer = safeReadFile(pathResolver.rootResolve(logicalPath), { encoding: null }) as Buffer;
  const ext = path.extname(logicalPath).toLowerCase();
  return {
    status: 'succeeded',
    path: logicalPath,
    bytes: buffer.length,
    extension: ext,
    mime_guess:
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      'application/octet-stream',
  };
}

async function ocrImage(params: any) {
  const logicalPath = String(params.path || '');
  if (!logicalPath) throw new Error('ocr_image requires params.path');
  
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(params.language || 'eng');
  const result = await worker.recognize(pathResolver.rootResolve(logicalPath));
  await worker.terminate();

  return {
    status: 'succeeded',
    path: logicalPath,
    language: params.language || 'eng',
    text: result.data.text,
    confidence: result.data.confidence,
  };
}

async function handleSingleAction(input: any) {
  const { action, params } = input;
  if (action === 'inspect_image') return inspectImage(params);
  if (action === 'ocr_image') return ocrImage(params);
  if (!LEGACY_MEDIA_GENERATION_ACTIONS.has(action)) {
    throw new Error(`Vision actuator is being narrowed to perception workflows. Unsupported legacy action: ${action}`);
  }
  logger.warn(`🎨 [VISION:LEGACY] "${action}" is a legacy route. Prefer media-generation-actuator.`);
  return await executeServicePreset('media-generation', action, params);
}

export async function handleAction(input: any) {
  if (input.action === 'pipeline') {
    const results = [];
    for (const step of input.steps) {
      results.push(await handleSingleAction(step));
    }
    return { status: 'succeeded', results };
  }
  return await handleSingleAction(input);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string);
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

const isMain = process.argv[1] && (
  process.argv[1].endsWith('vision-actuator/src/index.ts') || 
  process.argv[1].endsWith('vision-actuator/dist/index.js') ||
  process.argv[1].endsWith('vision-actuator/src/index.js')
);

if (isMain) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
