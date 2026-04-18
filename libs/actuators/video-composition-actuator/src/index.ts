import AjvModule from 'ajv';
import {
  compileSchemaFromPath,
  getVideoCompositionTemplateRegistry,
  logger,
  pathResolver,
  safeReadFile,
  VideoRenderRuntime,
  writeVideoCompositionBundle,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { VideoCompositionADF } from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const videoCompositionActionValidate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/video-composition-action.schema.json'));

type VideoCompositionAction =
  | VideoCompositionADF
  | { action: 'prepare_video_composition'; params: { video_composition_adf: VideoCompositionADF; job_id?: string; bundle_dir?: string } }
  | { action: 'list_video_composition_templates'; params: Record<string, unknown> }
  | Record<string, any>;

export async function handleSingleAction(input: VideoCompositionAction) {
  if ((input as any).kind === 'video-composition-adf') {
    return prepareVideoComposition({
      video_composition_adf: input as VideoCompositionADF,
    });
  }
  const action = (input as any).action;
  if (action === 'prepare_video_composition') {
    return prepareVideoComposition(((input as any).params || {}));
  }
  if (action === 'list_video_composition_templates') {
    return listVideoCompositionTemplates();
  }
  throw new Error(`Unsupported video composition action: ${String((input as any)?.action || (input as any)?.kind)}`);
}

export async function handleAction(input: VideoCompositionAction) {
  validateVideoCompositionAction(input);
  if ((input as any).action === 'pipeline') {
    const results = [];
    for (const step of (input as any).steps) {
      validateVideoCompositionAction(step);
      results.push(await handleSingleAction(step));
    }
    return { status: 'succeeded', results };
  }
  return handleSingleAction(input);
}

function validateVideoCompositionAction(input: unknown): void {
  const ok = videoCompositionActionValidate(input);
  if (ok) return;
  const detail = (videoCompositionActionValidate.errors || [])
    .map((error: any) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`Invalid video composition action: ${detail}`);
}

async function listVideoCompositionTemplates() {
  const registry = getVideoCompositionTemplateRegistry();
  return {
    status: 'succeeded',
    default_template_id: registry.default_template_id,
    templates: registry.templates,
  };
}

async function prepareVideoComposition(params: {
  video_composition_adf?: VideoCompositionADF;
  job_id?: string;
  bundle_dir?: string;
}) {
  if (!params.video_composition_adf) {
    throw new Error('prepare_video_composition requires params.video_composition_adf');
  }

  const adf = params.video_composition_adf;
  const jobId = String(params.job_id || randomUUID());
  const runtime = new VideoRenderRuntime();
  const progressPackets: any[] = [];
  runtime.subscribe((packet) => {
    progressPackets.push(packet);
  });

  runtime.enqueue({
    jobId,
    async run(api) {
      api.report({
        status: 'validating_contract',
        progress: { current: 1, total: 4, percent: 25, unit: 'steps' },
        message: 'validated video composition contract',
      });
      api.report({
        status: 'resolving_templates',
        progress: { current: 2, total: 4, percent: 50, unit: 'steps' },
        message: `resolved ${adf.scenes.length} scene template(s)`,
      });
      api.report({
        status: 'assembling_bundle',
        progress: { current: 3, total: 4, percent: 75, unit: 'steps' },
        message: 'assembling deterministic composition bundle',
      });

      const plan = writeVideoCompositionBundle(adf, { bundleDir: params.bundle_dir });
      const artifactRefs = plan.artifact_refs;

      api.report({
        status: 'rendering',
        progress: { current: 4, total: 4, percent: 100, unit: 'steps' },
        message: 'bundle prepared; backend rendering remains disabled by policy',
        artifact_refs: artifactRefs,
      });

      return { artifactRefs };
    },
  });

  const finalPacket = await waitForRenderJob(runtime, jobId);
  return {
    status: finalPacket.status === 'completed' ? 'succeeded' : finalPacket.status,
    job_id: jobId,
    artifact_refs: finalPacket.artifact_refs || [],
    progress_packets: progressPackets,
    output_format: adf.output.format,
    backend_rendering_enabled: false,
  };
}

async function waitForRenderJob(runtime: VideoRenderRuntime, jobId: string): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const packet = runtime.getPacket(jobId);
    if (packet && ['completed', 'failed', 'cancelled'].includes(packet.status)) {
      return packet;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`video composition job timed out: ${jobId}`);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string);
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

const isMain = process.argv[1] && (
  process.argv[1].endsWith('video-composition-actuator/src/index.ts')
  || process.argv[1].endsWith('video-composition-actuator/dist/index.js')
  || process.argv[1].endsWith('video-composition-actuator/src/index.js')
);

if (isMain) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
