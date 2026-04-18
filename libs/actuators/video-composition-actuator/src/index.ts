import AjvModule from 'ajv';
import {
  compileSchemaFromPath,
  getVideoCompositionTemplateRegistry,
  getVideoRenderRuntimePolicy,
  logger,
  pathResolver,
  renderVideoCompositionBundleAsync,
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
  | { action: 'get_video_composition_job_status'; params: { job_id: string } }
  | { action: 'cancel_video_composition_job'; params: { job_id: string } }
  | { action: 'get_video_composition_queue'; params?: Record<string, unknown> }
  | Record<string, any>;

const runtime = new VideoRenderRuntime();
const packetHistory = new Map<string, any[]>();
runtime.subscribe((packet) => {
  const history = packetHistory.get(packet.job_id) || [];
  history.push(packet);
  if (history.length > 200) history.shift();
  packetHistory.set(packet.job_id, history);
});

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
  if (action === 'get_video_composition_job_status') {
    return getVideoCompositionJobStatus(((input as any).params || {}));
  }
  if (action === 'cancel_video_composition_job') {
    return cancelVideoCompositionJob(((input as any).params || {}));
  }
  if (action === 'get_video_composition_queue') {
    return getVideoCompositionQueue();
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

async function getVideoCompositionJobStatus(params: { job_id?: string }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('get_video_composition_job_status requires params.job_id');
  const packet = runtime.getPacket(jobId);
  if (!packet) {
    return {
      status: 'not_found',
      job_id: jobId,
      packet: null,
      progress_packets: [],
    };
  }
  return {
    status: 'succeeded',
    job_id: jobId,
    packet,
    progress_packets: packetHistory.get(jobId) || [],
  };
}

async function cancelVideoCompositionJob(params: { job_id?: string }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('cancel_video_composition_job requires params.job_id');
  const cancellation = runtime.cancel(jobId);
  return {
    status: cancellation ? 'succeeded' : 'not_found',
    job_id: jobId,
    cancellation,
    packet: runtime.getPacket(jobId),
  };
}

async function getVideoCompositionQueue() {
  return {
    status: 'succeeded',
    queue: runtime.getQueueSnapshot(),
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
  const policy = getVideoRenderRuntimePolicy();
  const jobId = String(params.job_id || randomUUID());
  const awaitCompletion = adf.output.await_completion !== false;

  runtime.enqueue({
    jobId,
    async run(api) {
      const totalSteps = policy.render.enable_backend_rendering ? 5 : 4;
      api.report({
        status: 'validating_contract',
        progress: { current: 1, total: totalSteps, percent: (1 / totalSteps) * 100, unit: 'steps' },
        message: 'validated video composition contract',
      });
      api.report({
        status: 'resolving_templates',
        progress: { current: 2, total: totalSteps, percent: (2 / totalSteps) * 100, unit: 'steps' },
        message: `resolved ${adf.scenes.length} scene template(s)`,
      });
      api.report({
        status: 'assembling_bundle',
        progress: { current: 3, total: totalSteps, percent: (3 / totalSteps) * 100, unit: 'steps' },
        message: 'assembling deterministic composition bundle',
      });

      const plan = writeVideoCompositionBundle(adf, { bundleDir: params.bundle_dir });
      let artifactRefs = [...plan.artifact_refs];
      let backendOutputPath: string | undefined;

      if (policy.render.enable_backend_rendering) {
        if (api.isCancelled()) throw new Error('video composition job cancelled');
        api.report({
          status: 'rendering',
          progress: { current: 4, total: totalSteps, percent: (4 / totalSteps) * 100, unit: 'steps' },
          message: `rendering composed video via backend ${policy.render.backend}`,
          artifact_refs: artifactRefs,
        });

        const backendResult = await renderVideoCompositionBundleAsync(plan, policy, {
          isCancelled: api.isCancelled,
        });
        if (backendResult.output_path) {
          backendOutputPath = backendResult.output_path;
          artifactRefs = [...artifactRefs, backendOutputPath];
        }

        if (api.isCancelled()) throw new Error('video composition job cancelled');
        api.report({
          status: 'encoding',
          progress: { current: 5, total: totalSteps, percent: 100, unit: 'steps' },
          message: backendResult.executed
            ? 'backend render completed'
            : (backendResult.reason || 'backend skipped'),
          artifact_refs: artifactRefs,
        });
      } else {
        api.report({
          status: 'rendering',
          progress: { current: 4, total: totalSteps, percent: 100, unit: 'steps' },
          message: 'bundle prepared; backend rendering remains disabled by policy',
          artifact_refs: artifactRefs,
        });
      }

      return { artifactRefs, backendOutputPath };
    },
  });

  if (!awaitCompletion) {
    return {
      status: 'queued',
      job_id: jobId,
      await_completion: false,
      packet: runtime.getPacket(jobId),
      queue: runtime.getQueueSnapshot(),
      output_format: adf.output.format,
      backend_rendering_enabled: policy.render.enable_backend_rendering,
      backend_render_backend: policy.render.backend,
    };
  }

  const finalPacket = await waitForRenderJob(runtime, jobId);
  const renderedOutputPath = (finalPacket.artifact_refs || []).find((ref: string) => ref.endsWith(`.${adf.output.format}`));
  const backendRendered = Boolean(policy.render.enable_backend_rendering && renderedOutputPath);
  return {
    status: finalPacket.status === 'completed' ? 'succeeded' : finalPacket.status,
    job_id: jobId,
    artifact_refs: finalPacket.artifact_refs || [],
    progress_packets: packetHistory.get(jobId) || [],
    output_format: adf.output.format,
    backend_rendering_enabled: policy.render.enable_backend_rendering,
    backend_render_backend: policy.render.backend,
    backend_rendered: backendRendered,
    rendered_output_path: renderedOutputPath,
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
