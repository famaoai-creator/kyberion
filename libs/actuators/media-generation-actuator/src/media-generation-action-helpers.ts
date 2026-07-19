import {
  logger,
  executeServicePreset,
  derivePipelineStatus,
  createActuatorTrace,
  finalizeActuatorTrace,
  safeExistsSync,
  waitForJob,
  classifyError,
} from '@agent/core';
import type { GenerationJob } from '@agent/core';
import { handleCaptureAction } from './capture-actions.js';
import { transitionGenerationJob } from './generation-job-state.js';
import { MEDIA_GENERATION_ACTIONS } from './op-catalog.js';

type MediaActionResult = Record<string, unknown> & Partial<GenerationJob>;
type MediaActionInput = {
  action?: string;
  params?: Record<string, unknown>;
  steps?: MediaActionInput[];
  continue_on_error?: boolean;
  [key: string]: unknown;
};
const SUPPORTED_ACTIONS = new Set<string>(MEDIA_GENERATION_ACTIONS);
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
  resolveAwaitCompletion,
  executePreparedGeneration,
  collectGenerationResult,
  nowIso,
  isPlainObject,
  loadRecoveryPolicy,
  resolveArtifactPath,
} from './media-generation-helpers.js';
import { getGenerationHistoryAdapterForAction } from './generation-artifact-adapters.js';
import { createComfyUiProviderClient } from './comfyui-provider-client.js';

const PROMPT_BASED_ACTIONS = new Set([
  'generate_image',
  'generate_video',
  'generate_music',
  'run_workflow',
]);
async function retryGenerationJob(job: GenerationJob): Promise<GenerationJob> {
  const classification = String(job.result?.retry_classification || 'unknown');
  const retryableCategories = loadRecoveryPolicy().retryable_categories;
  if (!Array.isArray(retryableCategories) || !retryableCategories.includes(classification)) {
    return writeJob(job);
  }
  const maxAttempts = Number(job.retry_policy?.max_attempts || 1);
  if ((job.attempts || 1) >= maxAttempts) {
    return writeJob(job);
  }
  const backoffSeconds = Number(job.retry_policy?.backoff_seconds || 0);
  const nextRetryAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
  const retryingJob = transitionGenerationJob(job, 'retrying', {
    next_retry_at: nextRetryAt,
    updated_at: nowIso(),
  });
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
  const resubmitted = transitionGenerationJob(job, 'submitted', {
    ...retried,
    result: {
      ...job.result,
      ...retried.result,
    },
    next_retry_at: undefined,
  });
  return writeJob(resubmitted);
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
      params.video_adf?.output?.await_completion
    ),
  });
  let result: any = null;
  try {
    const prepared = preparePromptBasedGeneration(action, params);
    if (
      action === 'generate_image' &&
      !prepared.workflow &&
      !prepared.params.workflow_path &&
      !prepared.params.image_adf
    ) {
      const { generateImage } = await import('@agent/core');
      const backend = resolveGenerationBackend(action, prepared.params);
      const bridgeRes = await generateImage({
        prompt: typeof prepared.params.prompt === 'string' ? prepared.params.prompt : '',
        aspectRatio: prepared.params.aspect_ratio || prepared.params.aspectRatio,
        mode: prepared.params.mode,
        style: typeof prepared.params.style === 'string' ? prepared.params.style : undefined,
        providerPreference: resolveImageProviderPreference(prepared.params),
        targetPath: prepared.params.target_path || prepared.params.targetPath,
        awaitCompletion: resolveAwaitCompletion(action, prepared.params),
      });

      const artifactExists = Boolean(
        bridgeRes.status === 'succeeded' && bridgeRes.path && safeExistsSync(bridgeRes.path)
      );
      const status =
        bridgeRes.status === 'submitted'
          ? 'submitted'
          : bridgeRes.status === 'succeeded' && artifactExists
            ? 'succeeded'
            : bridgeRes.status === 'failed'
              ? 'failed'
              : 'failed';
      const artifact =
        artifactExists && bridgeRes.path
          ? {
              id: 'primary',
              format: resolveImageArtifactFormat(bridgeRes.path),
              path: bridgeRes.path,
            }
          : null;

      result = {
        status,
        action,
        prompt_id: bridgeRes.promptId || 'direct_api',
        provider_job_id: bridgeRes.promptId,
        artifacts: artifact ? [artifact] : [],
        artifact,
        copied_to: artifact?.path,
        backend_id: bridgeRes.provider || backend.backend_id,
        resolved_backend_id: backend.backend_id,
        backend_kind: backend.kind,
        backend_provider: backend.provider,
        modality: backend.modality,
        error: bridgeRes.error,
      };

      traceCtx.endSpan('ok');
      return { ...result, ...finalizeActuatorTrace(traceCtx) };
    }

    const { compiled, workflow } = prepared;
    result = await executePreparedGeneration(action, { ...prepared, workflow });

    const backend = resolveGenerationBackend(action, prepared.params);
    result = {
      ...result,
      action,
      modality: backend.modality,
      backend_id: backend.backend_id,
      backend_kind: backend.kind,
      backend_provider: backend.provider,
      provider_job_id:
        typeof result?.provider_job_id === 'string'
          ? result.provider_job_id
          : typeof result?.prompt_id === 'string'
            ? result.prompt_id
            : undefined,
    };

    const promptId =
      typeof result?.provider_job_id === 'string'
        ? result.provider_job_id
        : typeof result?.prompt_id === 'string'
          ? result.prompt_id
          : undefined;
    if (!promptId) {
      traceCtx.endSpan('ok');
      return { ...result, ...finalizeActuatorTrace(traceCtx) };
    }

    const awaitCompletion = resolveAwaitCompletion(action, prepared.params);

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
    const result = await executePreparedGeneration(action, {
      ...compiled,
      action,
      params: requestParams,
      workflow,
    });
    const providerJobId =
      typeof result.provider_job_id === 'string'
        ? result.provider_job_id
        : typeof result.prompt_id === 'string'
          ? result.prompt_id
          : typeof result.job_id === 'string'
            ? result.job_id
            : undefined;
    if (!providerJobId) {
      throw new Error(`submit_generation failed to receive prompt_id for ${action}`);
    }

    const backend = resolveGenerationBackend(action, params.params || {});
    const job: GenerationJob = {
      kind: 'generation-job',
      job_id: params.existing_job_id || createGenerationJobId(action),
      action: action as GenerationJob['action'],
      status: 'submitted',
      provider: {
        engine: backend.provider,
        provider_job_id: providerJobId,
        prompt_id: providerJobId,
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
        modality: backend.modality,
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

    const promptId = String(
      currentJob.provider?.provider_job_id || currentJob.provider?.prompt_id || ''
    );
    if (!promptId) {
      traceCtx.endSpan('ok');
      return { ...currentJob, ...finalizeActuatorTrace(traceCtx) };
    }

    const history = (await createComfyUiProviderClient().history(promptId)) as unknown;
    if (!history || typeof history !== 'object' || Array.isArray(history)) {
      if (currentJob.status !== 'running') {
        const runningJob = transitionGenerationJob(currentJob, 'running', {
          kind: currentJob.kind || 'generation-job',
          updated_at: nowIso(),
        });
        traceCtx.endSpan('ok');
        return { ...writeJob(runningJob), ...finalizeActuatorTrace(traceCtx) };
      }
      traceCtx.endSpan('ok');
      return { ...currentJob, ...finalizeActuatorTrace(traceCtx) };
    }

    const promptHistory = (history as Record<string, unknown>)[promptId];
    if (!promptHistory) {
      if (currentJob.status !== 'running') {
        const runningJob = transitionGenerationJob(currentJob, 'running', {
          kind: currentJob.kind || 'generation-job',
          updated_at: nowIso(),
        });
        traceCtx.endSpan('ok');
        return { ...writeJob(runningJob), ...finalizeActuatorTrace(traceCtx) };
      }
      traceCtx.endSpan('ok');
      return { ...currentJob, ...finalizeActuatorTrace(traceCtx) };
    }

    const historyAdapter = getGenerationHistoryAdapterForAction(currentJob.action);
    if (historyAdapter.is_failed(promptHistory)) {
      throw new Error(`provider job ${promptId} failed or was canceled`);
    }

    const result = await collectGenerationResult(
      currentJob.action,
      currentJob.request || {},
      promptId,
      { resolved: currentJob.result?.compiled_generation_request }
    );
    if (result.status !== 'succeeded' || !result.artifact) {
      const failedJob = transitionGenerationJob(currentJob, 'failed', {
        kind: currentJob.kind || 'generation-job',
        result: {
          ...currentJob.result,
          artifacts: result.artifacts,
          error: 'artifact_collection_failed',
          retry_classification: 'resource_unavailable',
        },
        updated_at: nowIso(),
        completed_at: nowIso(),
      });
      traceCtx.endSpan('error', 'artifact_collection_failed');
      return { ...writeJob(failedJob), ...finalizeActuatorTrace(traceCtx) };
    }

    const succeededJob = transitionGenerationJob(currentJob, 'succeeded', {
      kind: currentJob.kind || 'generation-job',
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
    });
    traceCtx.endSpan('ok');
    return { ...writeJob(succeededJob), ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    if (job) {
      const classified = classifyError(err);
      const detail = err?.message ?? String(err);
      const retryClassification = detail.includes('policy_denied')
        ? 'policy_denied'
        : detail.toLowerCase().includes('unavailable')
          ? 'resource_unavailable'
          : classified.category;
      const failedJob = transitionGenerationJob(job, 'failed', {
        kind: job.kind || 'generation-job',
        result: {
          ...job.result,
          error: detail,
          retry_classification: retryClassification,
        },
        updated_at: nowIso(),
        completed_at: nowIso(),
      });
      writeJob(failedJob);
      const retried = await retryGenerationJob(failedJob);
      traceCtx.endSpan('error', detail);
      return {
        ...retried,
        retry_classification: retryClassification,
        ...finalizeActuatorTrace(traceCtx),
      };
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
    const waited = await waitForJob({
      getStatus: () => getGenerationJob({ job_id: jobId }),
      isTerminal: (job: any) => isTerminalStatus(job.status),
      timeoutMs,
      pollIntervalMs,
    });
    if (waited.status === 'completed') {
      traceCtx.endSpan('ok');
      return { ...waited.value, ...finalizeActuatorTrace(traceCtx) };
    }

    const current = readJob(jobId);
    traceCtx.endSpan('error', 'timed_out');
    return {
      ...current,
      wait_status: 'timed_out',
      status: current.status,
      updated_at: nowIso(),
      ...finalizeActuatorTrace(traceCtx),
    };
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
      throw new Error(
        `collect_generation_artifact requires succeeded job. Current status: ${job.status}`
      );
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

async function handleSingleAction(input: MediaActionInput) {
  const action = String(input.action || '');
  const params = input.params || {};
  if (!SUPPORTED_ACTIONS.has(String(action))) {
    throw new Error(`Unsupported media generation action: ${String(action)}`);
  }
  if (PROMPT_BASED_ACTIONS.has(action)) {
    return handlePromptBasedGeneration(action, params);
  }
  if (action === 'submit_generation') return submitGenerationJob(params);
  if (action === 'get_generation_job') return getGenerationJob(params);
  if (action === 'wait_generation_job') return waitGenerationJob(params);
  if (action === 'collect_generation_artifact') return collectGenerationArtifact(params);

  if (
    action === 'capture_screen' ||
    action === 'capture_focused_window' ||
    action === 'record_screen'
  ) {
    return handleCaptureAction(action, params);
  }

  logger.info(`🎬 [MEDIA-GEN:PROXY] Dispatching "${action}" to Service Engine...`);
  return await executeServicePreset('media-generation', action, params);
}

function mergeTraceEvidence(
  result: Record<string, unknown>,
  rootEvidence: ReturnType<typeof finalizeActuatorTrace>
): Record<string, unknown> {
  const childSummary = isPlainObject(result.trace_summary) ? result.trace_summary : undefined;
  const childSpans = typeof childSummary?.spans === 'number' ? childSummary.spans : 0;
  return {
    ...result,
    child_trace: result.trace,
    child_trace_summary: childSummary,
    trace: rootEvidence.trace,
    trace_summary: {
      ...rootEvidence.trace_summary,
      spans: rootEvidence.trace_summary.spans + childSpans,
    },
    trace_persisted_path: rootEvidence.trace_persisted_path,
  };
}

export async function handleAction(input: MediaActionInput): Promise<MediaActionResult> {
  const traceCtx = createActuatorTrace(
    'media-generation-actuator',
    String(input?.action || 'unknown')
  );
  traceCtx.startSpan(`media-generation:${String(input?.action || 'unknown')}`);
  if (input.action === 'pipeline') {
    const continueOnError = input.continue_on_error !== false;
    try {
      const results: Array<Record<string, unknown>> = [];
      let pipelineFailed = false;
      for (const step of input.steps || []) {
        traceCtx.startSpan(`media-generation:${String(step?.action || 'step')}`);
        try {
          const stepResult = await handleSingleAction(step);
          results.push(stepResult);
          if (stepResult?.status === 'failed' || stepResult?.status === 'error') {
            pipelineFailed = true;
            traceCtx.endSpan(
              'error',
              stepResult?.message ?? `step failed: ${String(step?.action || 'step')}`
            );
          } else {
            traceCtx.endSpan('ok');
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          pipelineFailed = true;
          traceCtx.endSpan('error', error.message);
          if (!continueOnError) throw error;
          results.push({
            action: String(step?.action || 'step'),
            status: 'failed',
            message: error.message,
          });
        }
      }
      traceCtx.endSpan(pipelineFailed ? 'error' : 'ok');
      return {
        status: derivePipelineStatus(
          results.map((result: any) => ({
            op: String(result?.action || result?.job_id || result?.prompt_id || 'step'),
            status:
              result?.status === 'failed' || result?.status === 'error' ? 'failed' : 'success',
          }))
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
    return mergeTraceEvidence(result, finalizeActuatorTrace(traceCtx));
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    traceCtx.endSpan('error', error.message);
    return { status: 'failed', message: error.message, ...finalizeActuatorTrace(traceCtx) };
  }
}
