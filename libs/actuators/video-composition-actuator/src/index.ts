import AjvModule from 'ajv';
import {
  compileNarratedVideoBriefToCompositionADF,
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
  | { action: 'compile_narrated_video_brief'; params: { narrated_video_brief: Record<string, unknown> } }
  | { action: 'list_video_composition_templates'; params: Record<string, unknown> }
  | { action: 'get_video_composition_job_status'; params: { job_id: string } }
  | { action: 'await_video_composition_job'; params: { job_id: string; timeout_ms?: number } }
  | { action: 'cancel_video_composition_job'; params: { job_id: string; reason?: string } }
  | { action: 'get_video_composition_queue'; params?: Record<string, unknown> }
  | Record<string, any>;

interface VideoCompositionJobDiagnostics {
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  terminal_status?: 'completed' | 'failed' | 'cancelled';
  cancellation_reason?: string;
  cancellation_requested_at?: string;
  backend_exit_signal?: string | null;
  backend_exit_code?: number | null;
  backend_cancelled?: boolean;
  backend_timed_out?: boolean;
  last_error?: string;
}

const runtime = new VideoRenderRuntime();
const packetHistory = new Map<string, any[]>();
const jobDiagnostics = new Map<string, VideoCompositionJobDiagnostics>();
runtime.subscribe((packet) => {
  trackLifecycleDiagnostics(packet);
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
  if (action === 'compile_narrated_video_brief') {
    return compileNarratedVideoBrief(((input as any).params || {}));
  }
  if (action === 'list_video_composition_templates') {
    return listVideoCompositionTemplates();
  }
  if (action === 'get_video_composition_job_status') {
    return getVideoCompositionJobStatus(((input as any).params || {}));
  }
  if (action === 'await_video_composition_job') {
    return awaitVideoCompositionJob(((input as any).params || {}));
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

async function compileNarratedVideoBrief(params: { narrated_video_brief?: Record<string, unknown> }) {
  if (!params.narrated_video_brief) {
    throw new Error('compile_narrated_video_brief requires params.narrated_video_brief');
  }
  const adf = compileNarratedVideoBriefToCompositionADF(params.narrated_video_brief as any);
  return {
    status: 'succeeded',
    kind: 'compiled_video_composition_adf',
    video_composition_adf: adf,
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
      diagnostics: null,
    };
  }
  return {
    status: 'succeeded',
    job_id: jobId,
    packet,
    progress_packets: packetHistory.get(jobId) || [],
    diagnostics: jobDiagnostics.get(jobId) || null,
  };
}

async function awaitVideoCompositionJob(params: { job_id?: string; timeout_ms?: number }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('await_video_composition_job requires params.job_id');
  const timeoutMs = normalizeAwaitTimeoutMs(params.timeout_ms);
  const packet = await waitForRenderJob(runtime, jobId, timeoutMs, true);
  if (!packet) {
    return {
      status: 'timeout',
      job_id: jobId,
      timeout_ms: timeoutMs,
      packet: runtime.getPacket(jobId),
      diagnostics: jobDiagnostics.get(jobId) || null,
    };
  }
  return {
    status: 'succeeded',
    job_id: jobId,
    packet,
    diagnostics: jobDiagnostics.get(jobId) || null,
    progress_packets: packetHistory.get(jobId) || [],
  };
}

async function cancelVideoCompositionJob(params: { job_id?: string; reason?: string }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('cancel_video_composition_job requires params.job_id');
  const reason = params.reason && String(params.reason).trim() ? String(params.reason).trim() : undefined;
  if (reason) {
    upsertJobDiagnostics(jobId, {
      cancellation_reason: reason,
      cancellation_requested_at: new Date().toISOString(),
    });
  }
  const cancellation = runtime.cancel(jobId, { reason });
  return {
    status: cancellation ? 'succeeded' : 'not_found',
    job_id: jobId,
    cancellation,
    packet: runtime.getPacket(jobId),
    diagnostics: jobDiagnostics.get(jobId) || null,
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
  const awaitCompletion = resolveAwaitCompletion(adf, policy);
  upsertJobDiagnostics(jobId, { created_at: new Date().toISOString() });

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

        let backendResult: any;
        try {
          backendResult = await renderVideoCompositionBundleAsync(plan, policy, {
            isCancelled: api.isCancelled,
          });
        } catch (error: any) {
          const backendState = extractBackendTerminationState(error);
          if (backendState) {
            upsertJobDiagnostics(jobId, backendState);
          }
          if (api.isCancelled() || backendState?.backend_cancelled) {
            api.report({
              status: 'cancelled',
              progress: { current: 4, total: totalSteps, percent: (4 / totalSteps) * 100, unit: 'steps' },
              message: formatCancellationMessage(jobId),
              artifact_refs: artifactRefs,
            });
            throw new Error('video composition job cancelled');
          }
          throw error;
        }
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
      await_completion_reason: policy.render.enable_backend_rendering
        ? 'backend rendering enabled: default asynchronous mode'
        : 'operator selected asynchronous mode',
      packet: runtime.getPacket(jobId),
      queue: runtime.getQueueSnapshot(),
      diagnostics: jobDiagnostics.get(jobId) || null,
      output_format: adf.output.format,
      backend_rendering_enabled: policy.render.enable_backend_rendering,
      backend_render_backend: policy.render.backend,
    };
  }

  const finalPacket = await waitForRenderJob(runtime, jobId, computeAwaitTimeoutMs(policy));
  if (!finalPacket) {
    return {
      status: 'timeout',
      job_id: jobId,
      timeout_ms: computeAwaitTimeoutMs(policy),
      packet: runtime.getPacket(jobId),
      diagnostics: jobDiagnostics.get(jobId) || null,
      output_format: adf.output.format,
      backend_rendering_enabled: policy.render.enable_backend_rendering,
      backend_render_backend: policy.render.backend,
    };
  }
  const renderedOutputPath = (finalPacket.artifact_refs || []).find((ref: string) => ref.endsWith(`.${adf.output.format}`));
  const backendRendered = Boolean(policy.render.enable_backend_rendering && renderedOutputPath);
  return {
    status: finalPacket.status === 'completed' ? 'succeeded' : finalPacket.status,
    job_id: jobId,
    artifact_refs: finalPacket.artifact_refs || [],
    progress_packets: packetHistory.get(jobId) || [],
    diagnostics: jobDiagnostics.get(jobId) || null,
    output_format: adf.output.format,
    backend_rendering_enabled: policy.render.enable_backend_rendering,
    backend_render_backend: policy.render.backend,
    backend_rendered: backendRendered,
    rendered_output_path: renderedOutputPath,
  };
}

async function waitForRenderJob(
  runtime: VideoRenderRuntime,
  jobId: string,
  timeoutMs = 30_000,
  returnNullOnTimeout = false,
): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const packet = runtime.getPacket(jobId);
    if (packet && ['completed', 'failed', 'cancelled'].includes(packet.status)) {
      return packet;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (returnNullOnTimeout) return null;
  throw new Error(`video composition job timed out: ${jobId}`);
}

function resolveAwaitCompletion(adf: VideoCompositionADF, policy: ReturnType<typeof getVideoRenderRuntimePolicy>): boolean {
  if (adf.output.await_completion === true) return true;
  if (adf.output.await_completion === false) return false;
  return !policy.render.enable_backend_rendering;
}

function computeAwaitTimeoutMs(policy: ReturnType<typeof getVideoRenderRuntimePolicy>): number {
  return Math.max(30_000, Number(policy.render.command_timeout_ms || 0) + 60_000);
}

function normalizeAwaitTimeoutMs(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 30_000;
  return Math.max(10, Math.min(3_600_000, Math.floor(raw)));
}

function upsertJobDiagnostics(jobId: string, patch: Partial<VideoCompositionJobDiagnostics>): VideoCompositionJobDiagnostics {
  const current = jobDiagnostics.get(jobId) || {};
  const next = { ...current, ...patch };
  jobDiagnostics.set(jobId, next);
  return next;
}

function trackLifecycleDiagnostics(packet: any): void {
  const current = jobDiagnostics.get(packet.job_id) || {};
  const patch: Partial<VideoCompositionJobDiagnostics> = {};

  if (!current.created_at) {
    patch.created_at = packet.updated_at;
  }
  if (!current.started_at && packet.status !== 'queued') {
    patch.started_at = packet.updated_at;
  }
  if (['completed', 'failed', 'cancelled'].includes(packet.status)) {
    patch.finished_at = packet.updated_at;
    patch.terminal_status = packet.status;
    const startedMs = Date.parse(current.started_at || patch.started_at || packet.updated_at);
    const finishedMs = Date.parse(packet.updated_at);
    if (Number.isFinite(startedMs) && Number.isFinite(finishedMs)) {
      patch.duration_ms = Math.max(0, finishedMs - startedMs);
    }
    if (packet.status === 'failed' && packet.message) {
      patch.last_error = String(packet.message);
    }
  }
  if (Object.keys(patch).length > 0) {
    upsertJobDiagnostics(packet.job_id, patch);
  }
}

function extractBackendTerminationState(error: any): Partial<VideoCompositionJobDiagnostics> | null {
  if (!error || typeof error !== 'object') return null;
  const hasSignal = Object.prototype.hasOwnProperty.call(error, 'signal');
  const hasExitCode = Object.prototype.hasOwnProperty.call(error, 'exit_code');
  const hasCancelled = Object.prototype.hasOwnProperty.call(error, 'cancelled');
  const hasTimedOut = Object.prototype.hasOwnProperty.call(error, 'timed_out');
  if (!hasSignal && !hasExitCode && !hasCancelled && !hasTimedOut) return null;
  return {
    backend_exit_signal: hasSignal ? (error.signal as string | null) : undefined,
    backend_exit_code: hasExitCode ? (error.exit_code as number | null) : undefined,
    backend_cancelled: hasCancelled ? Boolean(error.cancelled) : undefined,
    backend_timed_out: hasTimedOut ? Boolean(error.timed_out) : undefined,
    last_error: error.message ? String(error.message) : undefined,
  };
}

function formatCancellationMessage(jobId: string): string {
  const diagnostic = jobDiagnostics.get(jobId);
  const reason = diagnostic?.cancellation_reason;
  const signal = diagnostic?.backend_exit_signal;
  if (reason && signal) return `cancelled: ${reason} (backend signal=${signal})`;
  if (reason) return `cancelled: ${reason}`;
  if (signal) return `cancelled (backend signal=${signal})`;
  return 'cancelled';
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
