import {
  logger,
  safeReadFile,
  executeServicePreset,
  pathResolver,
  classifyError,
  retry,
  ocrImage as coreOcrImage,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runActuatorCli } from '@agent/core';

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

const VISION_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/vision-actuator/manifest.json'
);
const DEFAULT_VISION_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(VISION_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories)
      ? recoveryPolicy.retryable_categories.map(String)
      : []
  );
  const resolved = {
    ...DEFAULT_VISION_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return (
        classification.category === 'network' ||
        classification.category === 'rate_limit' ||
        classification.category === 'timeout' ||
        classification.category === 'resource_unavailable'
      );
    },
  };
}

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
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : 'application/octet-stream',
  };
}

async function ocrImage(params: any) {
  const logicalPath = String(params.path || '');
  if (!logicalPath) throw new Error('ocr_image requires params.path');

  const result = await coreOcrImage({
    path: logicalPath,
    language: params.language,
    mode: params.mode,
    providerPreference: params.provider_preference || params.providerPreference,
    extractStructure: params.extract_structure || params.extractStructure,
  });

  return {
    status: result.status,
    path: logicalPath,
    language: params.language || 'eng',
    text: result.text,
    confidence: result.confidence,
    lines: result.lines,
    provider: result.provider,
  };
}

async function handleSingleAction(input: any) {
  const { action, params } = input;
  if (action === 'inspect_image') return inspectImage(params);
  if (action === 'ocr_image') return ocrImage(params);
  if (!LEGACY_MEDIA_GENERATION_ACTIONS.has(action)) {
    throw new Error(
      `Vision actuator is being narrowed to perception workflows. Unsupported legacy action: ${action}`
    );
  }
  logger.warn(
    `🎨 [VISION:LEGACY] "${action}" is a legacy route. Prefer media-generation-actuator.`
  );
  return await retry(
    async () => executeServicePreset('media-generation', action, params),
    buildRetryOptions()
  );
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
  await runActuatorCli({
    name: 'vision-actuator',
    handleAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
