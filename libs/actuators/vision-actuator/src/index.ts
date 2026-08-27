import {
  logger,
  safeReadFile,
  executeServicePreset,
  pathResolver,
  buildGovernedRetryOptions,
  classifyError,
  retry,
  ocrImage as coreOcrImage,
  describeImage as coreDescribeImage,
  ensureDefaultOpPreflight,
  runOpPreflight,
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

function buildRetryOptions(override?: Record<string, any>) {
  return buildGovernedRetryOptions({
    manifestPath: VISION_MANIFEST_PATH,
    defaults: DEFAULT_VISION_RETRY,
    override: override,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
}

export const actuator = defineCatalogBackedActuator({
  id: 'vision-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});

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
    // Where the image actually went. Pass mode: 'local_only' to require 'none'.
    provider_data_egress: result.providerDataEgress,
  };
}

async function describeImage(params: any) {
  const logicalPath = String(params.path || '');
  if (!logicalPath) throw new Error('describe_image requires params.path');
  const result = await coreDescribeImage({
    path: logicalPath,
    kind: params.kind,
  });
  return {
    status: result.status,
    path: logicalPath,
    description: result.description,
    provider: result.provider,
  };
}

async function handleSingleAction(input: any) {
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `vision:${String(input.action || '')}`,
    params: input.params || {},
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation vision:${String(input.action || '')} was not admitted.`}`
    );
  }
  const action = input.action;
  const params = preflight.input;
  if (action === 'inspect_image') return inspectImage(params);
  if (action === 'ocr_image') return ocrImage(params);
  if (action === 'describe_image') return describeImage(params);
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
    process.exitCode = 1;
  });
}
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
