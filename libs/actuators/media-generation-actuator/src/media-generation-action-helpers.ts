import {
  logger,
  executeServicePreset,
  derivePipelineStatus,
  createActuatorTrace,
  finalizeActuatorTrace,
  safeReadFile,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  pathResolver,
  platform,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import type { GenerationJob } from '@agent/core';
import {
  resolveGenerationBackend,
  buildRetryOptions,
  createGenerationJobId,
  type GeneratedArtifact,
  writeJob,
  readJob,
  extractArtifacts,
  isTerminalStatus,
  maybeCopyArtifact,
  resolveImageArtifactFormat,
  resolveImageProviderPreference,
  preparePromptBasedGeneration,
  collectGenerationResult,
  nowIso,
  isPlainObject,
  loadRecoveryPolicy,
  resolveArtifactPath,
  sleep,
} from './media-generation-helpers.js';

const PROMPT_BASED_ACTIONS = new Set(['generate_image', 'generate_video', 'generate_music', 'run_workflow']);
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'canceled']);

let cachedRecoveryPolicy: Record<string, any> | undefined;

async function retryGenerationJob(job: GenerationJob): Promise<GenerationJob> {
  const maxAttempts = Number(job.retry_policy?.max_attempts || 1);
  if ((job.attempts || 1) >= maxAttempts) {
    return writeJob(job);
  }
  const backoffSeconds = Number(job.retry_policy?.backoff_seconds || 0);
  const nextRetryAt = new Date(Date.now() + (backoffSeconds * 1000)).toISOString();
  const retryingJob: GenerationJob = {
    ...job,
    status: 'retrying',
    next_retry_at: nextRetryAt,
    updated_at: nowIso(),
  };
  return writeJob(retryingJob);
}

async function resumeRetriedGenerationJob(job: GenerationJob): Promise<GenerationJob> {
  const nextRetryAt = job.next_retry_at ? new Date(job.next_retry_at).getTime() : 0;
  if (nextRetryAt > Date.now()) {
    return job;
  }
  const retried = await submitGenerationJob({
    action: job.action,
    params: job.request,
    retry_policy: job.retry_policy,
    existing_job_id: job.job_id,
    next_attempt: (job.attempts || 1) + 1,
    created_at: job.created_at,
  });
  if (retried.status === 'failed' || !('job_id' in retried)) {
    return writeJob({
      ...job,
      status: 'failed',
      result: {
        ...job.result,
        error: (retried as any).message || 'retry submission failed',
      },
      next_retry_at: undefined,
      updated_at: nowIso(),
      completed_at: nowIso(),
    });
  }
  return writeJob({
    ...retried,
    result: {
      ...job.result,
      ...retried.result,
    },
    next_retry_at: undefined,
  });
}

async function handlePromptBasedGeneration(action: string, params: any) {
  const traceCtx = createActuatorTrace('media-generation-actuator', action, {
    pipelineId: String(params?.request_id || params?.job_id || ''),
  });
  traceCtx.startSpan(`media-generation:${action}`, {
    await_completion: Boolean(
      params.await_completion ??
      params.music_adf?.output?.await_completion ??
      params.image_adf?.output?.await_completion ??
      params.video_adf?.output?.await_completion,
    ),
  });
  let result: any = null;
  try {
    if (action === 'generate_image' && !params.workflow && !params.workflow_path && !params.image_adf) {
      const { generateImage } = await import('@agent/core');
      const bridgeRes = await generateImage({
        prompt: params.prompt || '',
        aspectRatio: params.aspect_ratio || params.aspectRatio,
        mode: params.mode,
        providerPreference: resolveImageProviderPreference(params),
        targetPath: params.target_path || params.targetPath,
        awaitCompletion: params.await_completion ?? true,
      });

      if (bridgeRes.status === 'failed') {
        throw new Error(bridgeRes.error || 'generation_failed');
      }

      result = {
        status: 'succeeded',
        action,
        prompt_id: bridgeRes.promptId || 'direct_api',
        artifacts: bridgeRes.path ? [{ id: 'primary', format: resolveImageArtifactFormat(bridgeRes.path), path: bridgeRes.path }] : [],
        artifact: bridgeRes.path ? { id: 'primary', format: resolveImageArtifactFormat(bridgeRes.path), path: bridgeRes.path } : null,
        copied_to: bridgeRes.path,
        backend_id: bridgeRes.provider,
      };

      traceCtx.endSpan('ok');
      return { ...result, ...finalizeActuatorTrace(traceCtx) };
    }

    const { compiled, workflow } = preparePromptBasedGeneration(action, params);
    result = await executeServicePreset('media-generation', action, {
      ...params,
      workflow,
    });

    const promptId = result?.prompt_id;
    if (!promptId) {
      traceCtx.endSpan('ok');
      return { ...result, ...finalizeActuatorTrace(traceCtx) };
    }

    const awaitCompletion =
      params.await_completion ??
      params.music_adf?.output?.await_completion ??
      Boolean(params.music_adf);

    if (awaitCompletion && !workflow) {
      throw new Error(`${action} requires params.workflow when await_completion is enabled`);
    }

    if (!awaitCompletion) {
      if (!compiled) {
        traceCtx.endSpan('ok');
        return { ...result, ...finalizeActuatorTrace(traceCtx) };
      }
      const next = {
        ...result,
        status: 'submitted',
        compiled_generation_request: compiled?.resolved,
      };
      traceCtx.endSpan('ok');
      return { ...next, ...finalizeActuatorTrace(traceCtx) };
    }

    const collected = await collectGenerationResult(action, params, promptId, compiled);
    traceCtx.endSpan('ok');
    return { ...collected, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'failed',
      message: err?.message ?? String(err),
      ...(result || {}),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

async function submitGenerationJob(params: any) {
  const traceCtx = createActuatorTrace('media-generation-actuator', 'submit_generation', {
    pipelineId: String(params?.existing_job_id || params?.job_id || ''),
  });
  traceCtx.startSpan('media-generation:submit_generation');
  try {
    const action = String(params.action || '');
    if (!PROMPT_BASED_ACTIONS.has(action)) {
      throw new Error(`submit_generation requires a prompt-based action. Received: ${action}`);
    }

    const { compiled, workflow } = preparePromptBasedGeneration(action, params.params || {});
    const requestParams = { ...(params.params || {}), workflow };
    const result = await executeServicePreset('media-generation', action, requestParams);
    if (!result?.prompt_id) {
      throw new Error(`submit_generation failed to receive prompt_id for ${action}`);
    }

    const backend = resolveGenerationBackend(action, params.params || {});
    const job: GenerationJob = {
      kind: 'generation-job',
      job_id: params.existing_job_id || createGenerationJobId(action),
      action: action as any,
      status: 'submitted',
      provider: {
        engine: 'comfyui',
        prompt_id: String(result.prompt_id),
      },
      request: {
        ...requestParams,
        target_path: params.params?.target_path || params.params?.music_adf?.output?.target_path,
        music_adf: params.params?.music_adf,
        image_adf: params.params?.image_adf,
        video_adf: params.params?.video_adf,
        workflow_path: params.params?.workflow_path,
      },
      result: {
        compiled_music_adf: compiled?.resolved,
        compiled_generation_request: compiled?.resolved,
        backend_id: backend.backend_id,
        backend_kind: backend.kind,
        backend_provider: backend.provider,
      },
      retry_policy: params.retry_policy || {
        max_attempts: Number(loadRecoveryPolicy().retry?.maxRetries || 1),
        backoff_seconds: Number((loadRecoveryPolicy().retry?.initialDelayMs || 0) / 1000),
      },
      attempts: Number(params.next_attempt || 1),
      created_at: params.created_at || nowIso(),
      updated_at: nowIso(),
    };

    writeJob(job);
    traceCtx.endSpan('ok');
    return { ...job, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'failed',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

async function getGenerationJob(params: any) {
  const traceCtx = createActuatorTrace('media-generation-actuator', 'get_generation_job', {
    pipelineId: String(params?.job_id || ''),
  });
  traceCtx.startSpan('media-generation:get_generation_job');
  let job: GenerationJob | undefined;
  try {
    const jobId = String(params.job_id || '');
    if (!jobId) throw new Error('get_generation_job requires job_id');
    job = readJob(jobId) as GenerationJob;
    const currentJob = job;
    if (currentJob.status === 'retrying') {
      const resumed = await resumeRetriedGenerationJob(currentJob);
      traceCtx.endSpan('ok');
      return { ...resumed, ...finalizeActuatorTrace(traceCtx) };
    }
    if (isTerminalStatus(currentJob.status)) {
      traceCtx.endSpan('ok');
      return { ...currentJob, ...finalizeActuatorTrace(traceCtx) };
    }

    const promptId = String(currentJob.provider?.prompt_id || '');
    if (!promptId) {
      traceCtx.endSpan('ok');
      return { ...currentJob, ...finalizeActuatorTrace(traceCtx) };
    }

    const history = await import('@agent/core').then(({ secureFetch }) => secureFetch({
      method: 'GET',
      url: `${process.env.KYBERION_COMFY_BASE_URL || 'http://127.0.0.1:8188'}/history/${promptId}`,
    }));
    if (!history || Object.keys(history).length === 0 || !history[promptId]) {
      if (currentJob.status !== 'running') {
        const runningJob = {
          ...currentJob,
          kind: currentJob.kind || 'generation-job',
          status: 'running',
          updated_at: nowIso(),
        } as GenerationJob;
        traceCtx.endSpan('ok');
        return { ...writeJob(runningJob), ...finalizeActuatorTrace(traceCtx) };
      }
      traceCtx.endSpan('ok');
      return { ...currentJob, ...finalizeActuatorTrace(traceCtx) };
    }

    const result = await collectGenerationResult(currentJob.action, currentJob.request || {}, promptId, { resolved: currentJob.result?.compiled_generation_request });
    const succeededJob: GenerationJob = {
      ...currentJob,
      kind: currentJob.kind || 'generation-job',
      status: 'succeeded',
      result: {
        ...currentJob.result,
        artifact: result.artifact || undefined,
        artifacts: result.artifacts,
        copied_to: result.copied_to,
        compiled_generation_request: result.compiled_generation_request,
        backend_id: result.backend_id,
        backend_kind: result.backend_kind,
        backend_provider: result.backend_provider,
      },
      updated_at: nowIso(),
      completed_at: nowIso(),
    };
    traceCtx.endSpan('ok');
    return { ...writeJob(succeededJob), ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    if (job) {
      const failedJob: GenerationJob = {
        ...job,
        kind: job.kind || 'generation-job',
        status: 'failed',
        result: {
          ...job.result,
          error: err?.message ?? String(err),
        },
        updated_at: nowIso(),
        completed_at: nowIso(),
      };
      writeJob(failedJob);
      const retried = await retryGenerationJob(failedJob);
      traceCtx.endSpan('error', err?.message ?? String(err));
      return { ...retried, ...finalizeActuatorTrace(traceCtx) };
    }
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'failed',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

async function waitGenerationJob(params: any) {
  const traceCtx = createActuatorTrace('media-generation-actuator', 'wait_generation_job', {
    pipelineId: String(params?.job_id || ''),
  });
  traceCtx.startSpan('media-generation:wait_generation_job');
  try {
    const jobId = String(params.job_id || '');
    if (!jobId) throw new Error('wait_generation_job requires job_id');
    const timeoutMs = Number(params.timeout_ms || 15 * 60 * 1000);
    const pollIntervalMs = Number(params.poll_interval_ms || 5_000);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const job = await getGenerationJob({ job_id: jobId });
      if (isTerminalStatus(job.status)) {
        traceCtx.endSpan('ok');
        return { ...job, ...finalizeActuatorTrace(traceCtx) };
      }
      await sleep(pollIntervalMs);
    }

    const timedOut = {
      ...readJob(jobId),
      kind: (readJob(jobId) as GenerationJob).kind || 'generation-job',
      status: 'timed_out',
      updated_at: nowIso(),
      completed_at: nowIso(),
      next_retry_at: undefined,
    } as GenerationJob;
    traceCtx.endSpan('error', 'timed_out');
    return { ...writeJob(timedOut), ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'failed',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

async function collectGenerationArtifact(params: any) {
  const traceCtx = createActuatorTrace('media-generation-actuator', 'collect_generation_artifact', {
    pipelineId: String(params?.job_id || ''),
  });
  traceCtx.startSpan('media-generation:collect_generation_artifact');
  try {
    const jobId = String(params.job_id || '');
    if (!jobId) throw new Error('collect_generation_artifact requires job_id');
    const job = readJob(jobId);
    if (job.status !== 'succeeded') {
      throw new Error(`collect_generation_artifact requires succeeded job. Current status: ${job.status}`);
    }
    const artifact = job.result?.artifact as GeneratedArtifact | undefined;
    if (!artifact?.path) {
      throw new Error(`collect_generation_artifact found no artifact path for job ${jobId}`);
    }
    const targetPath = String(params.target_path || job.request?.target_path || '');
    const copiedTo = maybeCopyArtifact(artifact.path, targetPath || undefined);
    const updatedJob: GenerationJob = {
      ...job,
      result: {
        ...job.result,
        copied_to: copiedTo || job.result?.copied_to,
      },
      updated_at: nowIso(),
    };
    writeJob(updatedJob);
    traceCtx.endSpan('ok');
    return { ...updatedJob, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'failed',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

async function handleSingleAction(input: any) {
  const { action, params } = input;
  if (PROMPT_BASED_ACTIONS.has(action)) {
    return handlePromptBasedGeneration(action, params);
  }
  if (action === 'submit_generation') return submitGenerationJob(params);
  if (action === 'get_generation_job') return getGenerationJob(params);
  if (action === 'wait_generation_job') return waitGenerationJob(params);
  if (action === 'collect_generation_artifact') return collectGenerationArtifact(params);

  if (action === 'capture_screen' || action === 'capture_focused_window') {
    const outputPath = pathResolver.rootResolve(params.output || `active/shared/tmp/capture-${Date.now()}.jpg`);
    if (action === 'capture_screen') {
      await platform.captureScreen(outputPath);
    } else {
      await platform.captureFocusedWindow(outputPath);
    }
    return { status: 'succeeded', path: params.output || outputPath };
  }

  logger.info(`🎬 [MEDIA-GEN:PROXY] Dispatching "${action}" to Service Engine...`);
  return await executeServicePreset('media-generation', action, params);
}

export async function handleAction(input: any) {
  const traceCtx = createActuatorTrace('media-generation-actuator', String(input?.action || 'unknown'));
  traceCtx.startSpan(`media-generation:${String(input?.action || 'unknown')}`);
  if (input.action === 'pipeline') {
    try {
      const results: Array<Record<string, unknown>> = [];
      for (const step of input.steps) {
        traceCtx.startSpan(`media-generation:${String(step?.action || 'step')}`);
        try {
          const stepResult = await handleSingleAction(step);
          results.push(stepResult);
          if (stepResult?.status === 'failed' || stepResult?.status === 'error') {
            traceCtx.endSpan('error', stepResult?.message ?? `step failed: ${String(step?.action || 'step')}`);
          } else {
            traceCtx.endSpan('ok');
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          traceCtx.endSpan('error', error.message);
          throw error;
        }
      }
      traceCtx.endSpan('ok');
      return {
        status: derivePipelineStatus(
          results.map((result: any) => ({
            op: String(result?.action || result?.job_id || result?.prompt_id || 'step'),
            status: result?.status === 'failed' || result?.status === 'error' ? 'failed' : 'success',
          })),
        ),
        results,
        ...finalizeActuatorTrace(traceCtx),
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      traceCtx.endSpan('error', error.message);
      return { status: 'failed', message: error.message, ...finalizeActuatorTrace(traceCtx) };
    }
  }
  try {
    const result = await handleSingleAction(input);
    traceCtx.endSpan('ok');
    return { ...result, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    traceCtx.endSpan('error', error.message);
    return { status: 'failed', message: error.message, ...finalizeActuatorTrace(traceCtx) };
  }
}
