import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  compileNarratedVideoBriefToCompositionADF,
  compileVideoCompositionADF,
  compileVideoContentBriefToStoryboard,
  compileVideoStoryboardToNarratedVideoBrief,
  getVideoCompositionTemplateRegistry,
  getVideoRenderRuntimePolicy,
  logger,
  pathResolver,
  renderNarratedFallbackVideo,
  renderVideoCompositionBundleAsync,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeWriteFile,
  withRetry,
  writeVideoCompositionBundle,
} from '@agent/core';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoCompositionADF } from '@agent/core';
import {
  buildRetryOptions,
  computeAwaitTimeoutMs,
  deepResolve,
  extractBackendTerminationState,
  formatCancellationMessage,
  jobDiagnostics,
  normalizeAwaitTimeoutMs,
  packetHistory,
  resolveActionParams,
  resolveAwaitCompletion,
  isPlainObject,
  runtime,
  trackLifecycleDiagnostics,
  upsertJobDiagnostics,
  validateVideoCompositionAction,
  DEFAULT_VIDEO_RETRY,
  waitForRenderJob,
} from './video-composition-helpers.js';

type VideoCompositionAction =
  | VideoCompositionADF
  | { action: 'prepare_video_composition'; params: { video_composition_adf: VideoCompositionADF; job_id?: string; bundle_dir?: string } }
  | { action: 'compile_narrated_video_brief'; params: { narrated_video_brief: Record<string, unknown> } }
  | { action: 'compile_video_content_brief'; params: { video_content_brief: Record<string, unknown> } }
  | {
    action: 'create_narrated_video_from_content_brief';
    params: {
      video_content_brief: Record<string, unknown>;
      narration_artifact_ref: string;
      job_id?: string;
      bundle_dir?: string;
      output?: Record<string, unknown>;
    };
  }
  | {
    action: 'create_narrated_intro_movie';
    params: {
      narrated_video_brief: Record<string, unknown>;
      job_id?: string;
      bundle_dir?: string;
    };
  }
  | { action: 'list_video_composition_templates'; params: Record<string, unknown> }
  | { action: 'get_video_composition_job_status'; params: { job_id: string } }
  | { action: 'await_video_composition_job'; params: { job_id: string; timeout_ms?: number } }
  | { action: 'cancel_video_composition_job'; params: { job_id: string; reason?: string } }
  | { action: 'verify_rendered_video_artifact'; params: { path: string; require_audio?: boolean; require_video?: boolean; export_as?: string } }
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

interface VideoCompositionJobTicket {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  updated_at: string;
  bundle_dir: string;
  output_format: string;
  output_target_path?: string;
  await_completion: boolean;
  detached_background?: boolean;
  backend_rendering_enabled: boolean;
  backend_render_backend: string;
  artifact_refs?: string[];
  rendered_output_path?: string;
  diagnostics?: VideoCompositionJobDiagnostics | null;
}

const DETACHED_WORKER_SCRIPT = pathResolver.rootResolve('dist/libs/actuators/video-composition-actuator/src/index.js');

function writeVideoCompositionJobTicket(ticketPath: string, ticket: VideoCompositionJobTicket): void {
  safeMkdir(path.dirname(ticketPath), { recursive: true });
  safeWriteFile(ticketPath, JSON.stringify(ticket, null, 2));
}

function readVideoCompositionJobTicket(ticketPath: string): VideoCompositionJobTicket | null {
  if (!safeExistsSync(ticketPath)) return null;
  try {
    return JSON.parse(String(safeReadFile(ticketPath, { encoding: 'utf8' }))) as VideoCompositionJobTicket;
  } catch {
    return null;
  }
}

function spawnDetachedVideoCompositionWorker(inputPath: string): ChildProcessWithoutNullStreams | null {
  if (!safeExistsSync(DETACHED_WORKER_SCRIPT)) {
    return null;
  }
  const child = spawn(process.execPath, [DETACHED_WORKER_SCRIPT, '--input', inputPath], {
    cwd: pathResolver.rootDir(),
    env: {
      ...process.env,
      KYBERION_VIDEO_RENDER_RUN_MODE: 'in-process',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

runtime.subscribe((packet) => {
  trackLifecycleDiagnostics(packet);
  const history = packetHistory.get(packet.job_id) || [];
  history.push(packet);
  if (history.length > 200) history.shift();
  packetHistory.set(packet.job_id, history);
});

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

async function compileVideoContentBrief(params: { video_content_brief?: Record<string, unknown> }) {
  if (!params.video_content_brief) {
    throw new Error('compile_video_content_brief requires params.video_content_brief');
  }
  const storyboard = compileVideoContentBriefToStoryboard(params.video_content_brief as any);
  return {
    status: 'succeeded',
    kind: 'compiled_video_storyboard',
    video_storyboard: storyboard,
  };
}

async function createNarratedVideoFromContentBrief(params: {
  video_content_brief?: Record<string, unknown>;
  narration_artifact_ref?: string;
  job_id?: string;
  bundle_dir?: string;
  output?: Record<string, unknown>;
}) {
  if (!params.video_content_brief) {
    throw new Error('create_narrated_video_from_content_brief requires params.video_content_brief');
  }
  if (!params.narration_artifact_ref) {
    throw new Error('create_narrated_video_from_content_brief requires params.narration_artifact_ref');
  }
  const contentBrief = params.video_content_brief as any;
  const storyboard = compileVideoContentBriefToStoryboard(contentBrief);
  const narratedVideoBrief = compileVideoStoryboardToNarratedVideoBrief(storyboard, {
    title: contentBrief.title,
    language: contentBrief.language,
    narration_artifact_ref: params.narration_artifact_ref,
    brand_name: contentBrief.design_system_ref?.brand_name,
    theme_background_color: contentBrief.design_system_ref?.background_color,
    logo_path: contentBrief.design_system_ref?.logo_path,
    hero_path: contentBrief.design_system_ref?.hero_path,
    timing: {
      duration_sec: params.output?.duration_sec || contentBrief.duration_sec,
      fps: params.output?.fps || contentBrief.design_system_ref?.fps,
    },
    output: {
      format: params.output?.format as any || 'mp4',
      target_path: params.output?.target_path as string | undefined,
      bundle_dir: params.output?.bundle_dir as string | undefined || params.bundle_dir,
      await_completion: params.output?.await_completion as boolean | undefined,
      detached_background: params.output?.detached_background as boolean | undefined,
    },
  });
  const execution = await createNarratedIntroMovie({
    narrated_video_brief: narratedVideoBrief as any,
    job_id: params.job_id,
    bundle_dir: params.bundle_dir || (params.output?.bundle_dir as string | undefined),
  });
  return {
    status: execution.status,
    kind: 'narrated_content_brief_movie_run',
    video_storyboard: storyboard,
    narrated_video_brief: narratedVideoBrief,
    video_composition_adf: execution.video_composition_adf,
    execution,
  };
}

async function createNarratedIntroMovie(params: {
  narrated_video_brief?: Record<string, unknown>;
  job_id?: string;
  bundle_dir?: string;
}) {
  if (!params.narrated_video_brief) {
    throw new Error('create_narrated_intro_movie requires params.narrated_video_brief');
  }
  const adf = compileNarratedVideoBriefToCompositionADF(params.narrated_video_brief as any);
  const execution = await prepareVideoComposition({
    video_composition_adf: adf,
    job_id: params.job_id,
    bundle_dir: params.bundle_dir,
  });
  if (execution.rendered_output_path && execution.backend_rendering_enabled) {
    const requiresRepair = !(await isRenderableVideoArtifact(execution.rendered_output_path));
    if (requiresRepair) {
      const repairedPlan = compileVideoCompositionADF(adf as any);
      await renderNarratedFallbackVideo(
        repairedPlan,
        execution.rendered_output_path,
        new Error('backend render returned an invalid artifact'),
      );
    }
  }
  return {
    status: execution.status,
    kind: 'narrated_intro_movie_run',
    video_composition_adf: adf,
    execution,
  };
}

async function verifyRenderedVideoArtifact(params: {
  path?: string;
  require_audio?: boolean;
  require_video?: boolean;
  export_as?: string;
}) {
  const rootDir = pathResolver.rootDir();
  const artifactPath = pathResolver.rootResolve(String(params.path || '').trim());
  if (!artifactPath || !safeExistsSync(artifactPath)) {
    throw new Error(`verify_rendered_video_artifact requires an existing path: ${String(params.path || '')}`);
  }

  const requireAudio = params.require_audio !== false;
  const requireVideo = params.require_video !== false;
  const probeStream = (selector: string) => safeExec('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    selector,
    '-show_entries',
    'stream=index',
    '-of',
    'csv=p=0',
    artifactPath,
  ], {
    cwd: rootDir,
    timeoutMs: 30_000,
  }).trim();

  let audioProbe = '';
  let videoProbe = '';
  if (requireAudio) {
    audioProbe = probeStream('a:0');
    if (!audioProbe) {
      throw new Error(`verify_rendered_video_artifact found no audio stream in ${artifactPath}`);
    }
  }
  if (requireVideo) {
    videoProbe = probeStream('v:0');
    if (!videoProbe) {
      throw new Error(`verify_rendered_video_artifact found no video stream in ${artifactPath}`);
    }
  }

  return {
    status: 'succeeded',
    kind: 'video_artifact_verification',
    path: artifactPath,
    has_audio: Boolean(audioProbe),
    has_video: Boolean(videoProbe),
    output: artifactPath,
  };
}

async function isRenderableVideoArtifact(artifactPath: string): Promise<boolean> {
  if (!artifactPath || !safeExistsSync(artifactPath)) {
    return false;
  }

  try {
    if (safeStat(artifactPath).size < 1024) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const hasVideo = safeExec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      artifactPath,
    ]).trim();
    if (!hasVideo) {
      return false;
    }

    const hasAudio = safeExec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      artifactPath,
    ]).trim();

    return Boolean(hasAudio);
  } catch {
    return false;
  }
}

async function getVideoCompositionJobStatus(params: { job_id?: string; job_ticket_path?: string }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('get_video_composition_job_status requires params.job_id');
  const packet = runtime.getPacket(jobId);
  if (!packet) {
    const ticketPath = params.job_ticket_path ? pathResolver.rootResolve(String(params.job_ticket_path)) : null;
    const ticket = ticketPath ? readVideoCompositionJobTicket(ticketPath) : null;
    if (ticket) {
      return {
        status: 'succeeded',
        job_id: jobId,
        packet: ticket,
        progress_packets: packetHistory.get(jobId) || [],
        diagnostics: jobDiagnostics.get(jobId) || null,
        job_ticket_path: ticketPath,
      };
    }
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

async function awaitVideoCompositionJob(params: { job_id?: string; timeout_ms?: number; job_ticket_path?: string }) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('await_video_composition_job requires params.job_id');
  const timeoutMs = normalizeAwaitTimeoutMs(params.timeout_ms);
  const ticketPath = params.job_ticket_path ? pathResolver.rootResolve(String(params.job_ticket_path)) : null;

  if (ticketPath) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const livePacket = runtime.getPacket(jobId);
      if (livePacket && ['completed', 'failed', 'cancelled'].includes(livePacket.status)) {
        return {
          status: livePacket.status === 'completed' ? 'succeeded' : livePacket.status,
          job_id: jobId,
          packet: livePacket,
          diagnostics: jobDiagnostics.get(jobId) || null,
          progress_packets: packetHistory.get(jobId) || [],
          job_ticket_path: ticketPath,
        };
      }
      const ticket = readVideoCompositionJobTicket(ticketPath);
      if (ticket && ['completed', 'failed', 'cancelled'].includes(ticket.status)) {
        return {
          status: ticket.status === 'completed' ? 'succeeded' : ticket.status,
          job_id: jobId,
          packet: ticket,
          diagnostics: jobDiagnostics.get(jobId) || null,
          progress_packets: packetHistory.get(jobId) || [],
          job_ticket_path: ticketPath,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
      status: 'timeout',
      job_id: jobId,
      timeout_ms: timeoutMs,
      packet: runtime.getPacket(jobId) || readVideoCompositionJobTicket(ticketPath),
      diagnostics: jobDiagnostics.get(jobId) || null,
      job_ticket_path: ticketPath,
    };
  }
  const packet = await waitForRenderJob(runtime, jobId, timeoutMs, true);
  if (!packet) {
    return {
      status: 'timeout',
      job_id: jobId,
      timeout_ms: timeoutMs,
      packet: runtime.getPacket(jobId),
      diagnostics: jobDiagnostics.get(jobId) || null,
      job_ticket_path: ticketPath,
    };
  }
  return {
    status: 'succeeded',
    job_id: jobId,
    packet,
    diagnostics: jobDiagnostics.get(jobId) || null,
    progress_packets: packetHistory.get(jobId) || [],
    job_ticket_path: ticketPath || undefined,
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
  const bundlePreview = compileVideoCompositionADF(adf, { bundleDir: params.bundle_dir });
  const jobTicketPath = path.join(bundlePreview.bundle_dir, 'job-state.json');
  const runMode = String(process.env.KYBERION_VIDEO_RENDER_RUN_MODE || 'foreground');
  const detachedBackground = adf.output?.detached_background === true
    && awaitCompletion === false
    && policy.render.enable_backend_rendering
    && runMode !== 'in-process';
  upsertJobDiagnostics(jobId, { created_at: new Date().toISOString() });
  writeVideoCompositionJobTicket(jobTicketPath, {
    job_id: jobId,
    status: 'queued',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    bundle_dir: bundlePreview.bundle_dir,
    output_format: adf.output.format,
    output_target_path: adf.output.target_path,
    await_completion: awaitCompletion,
    detached_background: adf.output?.detached_background,
    backend_rendering_enabled: policy.render.enable_backend_rendering,
    backend_render_backend: policy.render.backend,
    diagnostics: jobDiagnostics.get(jobId) || null,
  });

  if (detachedBackground) {
    const requestPath = path.join(bundlePreview.bundle_dir, 'job-request.json');
    const requestPayload = {
      action: 'prepare_video_composition',
      params: {
        video_composition_adf: {
          ...adf,
          output: {
            ...adf.output,
            await_completion: false,
            detached_background: false,
          },
        },
        job_id: jobId,
        bundle_dir: bundlePreview.bundle_dir,
      },
    };
    safeWriteFile(requestPath, JSON.stringify(requestPayload, null, 2));
    const child = spawnDetachedVideoCompositionWorker(requestPath);
    if (!child) {
      logger.warn(`[VIDEO_COMPOSITION] Detached worker unavailable, falling back to in-process queue for ${jobId}`);
    } else {
      return {
        status: 'queued',
        job_id: jobId,
        job_ticket_path: jobTicketPath,
        await_completion: false,
        await_completion_reason: 'detached background worker launched',
        packet: runtime.getPacket(jobId),
        queue: runtime.getQueueSnapshot(),
        diagnostics: jobDiagnostics.get(jobId) || null,
        output_format: adf.output.format,
        output_target_path: adf.output.target_path,
        backend_rendering_enabled: policy.render.enable_backend_rendering,
        backend_render_backend: policy.render.backend,
        bundle_dir: bundlePreview.bundle_dir,
        detached_background: true,
      };
    }
  }

  runtime.enqueue({
    jobId,
    async run(api) {
      try {
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

        const plan = await withRetry(
          async () => writeVideoCompositionBundle(adf, { bundleDir: bundlePreview.bundle_dir }),
          buildRetryOptions(DEFAULT_VIDEO_RETRY),
        );
        let artifactRefs = [...plan.artifact_refs];
        let backendOutputPath: string | undefined;
        writeVideoCompositionJobTicket(jobTicketPath, {
          job_id: jobId,
          status: 'running',
          created_at: jobDiagnostics.get(jobId)?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          bundle_dir: plan.bundle_dir,
          output_format: adf.output.format,
          output_target_path: adf.output.target_path,
          await_completion: awaitCompletion,
          backend_rendering_enabled: policy.render.enable_backend_rendering,
          backend_render_backend: policy.render.backend,
          artifact_refs: artifactRefs,
          diagnostics: jobDiagnostics.get(jobId) || null,
        });

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
          backendResult = await withRetry(
            async () =>
              renderVideoCompositionBundleAsync(plan, policy, {
                isCancelled: api.isCancelled,
              }),
            buildRetryOptions(DEFAULT_VIDEO_RETRY),
          );
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
        writeVideoCompositionJobTicket(jobTicketPath, {
          job_id: jobId,
          status: 'completed',
          created_at: jobDiagnostics.get(jobId)?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          bundle_dir: plan.bundle_dir,
          output_format: adf.output.format,
          output_target_path: adf.output.target_path,
          await_completion: awaitCompletion,
          backend_rendering_enabled: policy.render.enable_backend_rendering,
          backend_render_backend: policy.render.backend,
          artifact_refs: artifactRefs,
          rendered_output_path: backendOutputPath,
          diagnostics: jobDiagnostics.get(jobId) || null,
        });

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

        writeVideoCompositionJobTicket(jobTicketPath, {
          job_id: jobId,
          status: 'completed',
          created_at: jobDiagnostics.get(jobId)?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          bundle_dir: plan.bundle_dir,
          output_format: adf.output.format,
          output_target_path: adf.output.target_path,
          await_completion: awaitCompletion,
          backend_rendering_enabled: policy.render.enable_backend_rendering,
          backend_render_backend: policy.render.backend,
          artifact_refs: artifactRefs,
          rendered_output_path: backendOutputPath,
          diagnostics: jobDiagnostics.get(jobId) || null,
        });

        return { artifactRefs, backendOutputPath };
      } catch (error: any) {
        writeVideoCompositionJobTicket(jobTicketPath, {
          job_id: jobId,
          status: api.isCancelled() ? 'cancelled' : 'failed',
          created_at: jobDiagnostics.get(jobId)?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          bundle_dir: bundlePreview.bundle_dir,
          output_format: adf.output.format,
          output_target_path: adf.output.target_path,
          await_completion: awaitCompletion,
          backend_rendering_enabled: policy.render.enable_backend_rendering,
          backend_render_backend: policy.render.backend,
          diagnostics: jobDiagnostics.get(jobId) || null,
        });
        throw error;
      }
    },
  });

  if (!awaitCompletion) {
    return {
      status: 'queued',
      job_id: jobId,
      job_ticket_path: jobTicketPath,
      await_completion: false,
      await_completion_reason: policy.render.enable_backend_rendering
        ? 'backend rendering enabled: default asynchronous mode'
        : 'operator selected asynchronous mode',
      packet: runtime.getPacket(jobId),
      queue: runtime.getQueueSnapshot(),
      diagnostics: jobDiagnostics.get(jobId) || null,
      output_format: adf.output.format,
      output_target_path: adf.output.target_path,
      backend_rendering_enabled: policy.render.enable_backend_rendering,
      backend_render_backend: policy.render.backend,
      bundle_dir: bundlePreview.bundle_dir,
      detached_background: false,
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

export async function handleSingleAction(input: VideoCompositionAction) {
  if ((input as any).kind === 'video-composition-adf') {
    return prepareVideoComposition({
      video_composition_adf: input as VideoCompositionADF,
    });
  }
  const action = (input as any).action;
  const params = resolveActionParams(input);
  if (action === 'prepare_video_composition') {
    return prepareVideoComposition(params);
  }
  if (action === 'compile_narrated_video_brief') {
    return compileNarratedVideoBrief(params);
  }
  if (action === 'compile_video_content_brief') {
    return compileVideoContentBrief(params);
  }
  if (action === 'create_narrated_video_from_content_brief') {
    return createNarratedVideoFromContentBrief(params);
  }
  if (action === 'create_narrated_intro_movie') {
    return createNarratedIntroMovie(params);
  }
  if (action === 'verify_rendered_video_artifact') {
    return verifyRenderedVideoArtifact(params);
  }
  if (action === 'list_video_composition_templates') {
    return listVideoCompositionTemplates();
  }
  if (action === 'get_video_composition_job_status') {
    return getVideoCompositionJobStatus(params);
  }
  if (action === 'await_video_composition_job') {
    return awaitVideoCompositionJob(params);
  }
  if (action === 'cancel_video_composition_job') {
    return cancelVideoCompositionJob(params);
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

export async function dispatchDecisionOp(
  op: string,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<{ handled: boolean; ctx: Record<string, unknown> }> {
  const resolvedParams = deepResolve(params, ctx);
  const payload = { action: op, ...(resolvedParams || {}) };
  const result = await handleSingleAction(payload as any);
  const exportAs = String((resolvedParams as any)?.export_as || '').trim();
  return {
    handled: true,
    ctx: exportAs ? { ...ctx, [exportAs]: result } : { ...ctx, last_video_result: result },
  };
}
