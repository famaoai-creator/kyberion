import {
  logger,
  safeReadFile,
  safeWriteFile,
  executeServicePreset,
  compileMusicGenerationADF,
  compileImageGenerationADF,
  compileVideoGenerationADF,
  secureFetch,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  pathResolver,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import type { GenerationJob } from '@agent/core';

/**
 * Media-Generation-Actuator v1.0.0 [THIN CLIENT]
 * Proxies generative image/video/music and screen capture workflows to the Adaptive Service Engine.
 */

const DEFAULT_COMFY_BASE_URL = process.env.KYBERION_COMFY_BASE_URL || 'http://127.0.0.1:8188';
const DEFAULT_COMFY_OUTPUT_DIR = process.env.KYBERION_COMFY_OUTPUT_DIR || '/Users/famaoai/Documents/comfy/ComfyUI/output';
const PROMPT_BASED_ACTIONS = new Set(['generate_image', 'generate_video', 'generate_music', 'run_workflow']);
const GENERATION_JOB_DIR = 'active/shared/runtime/media-generation/jobs';
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'canceled']);

type GeneratedArtifact = {
  kind: string;
  filename: string;
  type: string;
  subfolder?: string;
  path: string;
};

type PromptGenerationRequest = {
  action: string;
  params: any;
  compiled?: any;
  workflow?: any;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureGenerationJobDir(): void {
  if (!safeExistsSync(GENERATION_JOB_DIR)) {
    safeMkdir(GENERATION_JOB_DIR, { recursive: true });
  }
}

function createGenerationJobId(action: string): string {
  return `genjob-${action}-${Date.now()}`;
}

function generationJobPath(jobId: string): string {
  return path.join(GENERATION_JOB_DIR, `${jobId}.json`);
}

function writeJob(job: GenerationJob): GenerationJob {
  ensureGenerationJobDir();
  safeWriteFile(generationJobPath(job.job_id), JSON.stringify(job, null, 2));
  return job;
}

function readJob(jobId: string): GenerationJob {
  return JSON.parse(safeReadFile(generationJobPath(jobId), { encoding: 'utf8' }) as string) as GenerationJob;
}

function resolveArtifactPath(item: Record<string, any>): string {
  const typeDir = item.type && item.type !== 'output' ? String(item.type) : '';
  const subfolder = item.subfolder ? String(item.subfolder) : '';
  return path.join(DEFAULT_COMFY_OUTPUT_DIR, typeDir, subfolder, String(item.filename));
}

function extractArtifacts(history: any): GeneratedArtifact[] {
  const outputs = history?.outputs;
  if (!outputs || typeof outputs !== 'object') return [];

  const artifacts: GeneratedArtifact[] = [];
  for (const nodeOutput of Object.values(outputs) as any[]) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue;
    for (const [kind, value] of Object.entries(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item?.filename) continue;
        artifacts.push({
          kind,
          filename: String(item.filename),
          type: String(item.type || 'output'),
          subfolder: item.subfolder ? String(item.subfolder) : undefined,
          path: resolveArtifactPath(item),
        });
      }
    }
  }
  return artifacts;
}

async function waitForPromptCompletion(promptId: string, timeoutMs: number, pollIntervalMs: number): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const history = await secureFetch({
      method: 'GET',
      url: `${DEFAULT_COMFY_BASE_URL}/history/${promptId}`,
    });
    if (history && Object.keys(history).length > 0) {
      const promptHistory = history[promptId];
      if (promptHistory?.status?.completed || promptHistory?.outputs) {
        return promptHistory;
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for Comfy prompt ${promptId}`);
}

function isTerminalStatus(status?: string): boolean {
  return status ? TERMINAL_JOB_STATUSES.has(status) : false;
}

function maybeCopyArtifact(sourcePath: string, targetPath?: string): string | undefined {
  if (!targetPath) return undefined;
  if (!safeExistsSync(sourcePath)) {
    throw new Error(`Generated artifact not found: ${sourcePath}`);
  }
  safeMkdir(path.dirname(targetPath), { recursive: true });
  safeCopyFileSync(sourcePath, targetPath);
  return targetPath;
}

function preparePromptBasedGeneration(action: string, params: any): PromptGenerationRequest {
  const compiled =
    action === 'generate_music' && params.music_adf ? compileMusicGenerationADF(params.music_adf) :
    action === 'generate_image' && params.image_adf ? compileImageGenerationADF(params.image_adf) :
    action === 'generate_video' && params.video_adf ? compileVideoGenerationADF(params.video_adf) :
    null;
  const workflow = params.workflow || compiled?.workflow;
  const hasWorkflowPath = Boolean(params.workflow_path);
  if (!workflow && !hasWorkflowPath) {
    const message = action === 'generate_music'
      ? 'generate_music requires either params.workflow or params.music_adf'
      : action === 'generate_image'
        ? 'generate_image requires params.workflow, params.workflow_path, or params.image_adf'
        : action === 'generate_video'
          ? 'generate_video requires params.workflow, params.workflow_path, or params.video_adf'
          : `${action} requires params.workflow or params.workflow_path`;
    throw new Error(message);
  }
  return { action, params, compiled, workflow };
}

async function collectGenerationResult(action: string, params: any, promptId: string, compiled?: any) {
  const timeoutMs = Number(params.timeout_ms || params.music_adf?.output?.timeout_ms || 15 * 60 * 1000);
  const pollIntervalMs = Number(params.poll_interval_ms || params.music_adf?.output?.poll_interval_ms || 5_000);
  const history = await waitForPromptCompletion(promptId, timeoutMs, pollIntervalMs);
  const artifacts = extractArtifacts(history);
  const primaryArtifact = artifacts[0];
  const copiedTo = primaryArtifact
    ? maybeCopyArtifact(primaryArtifact.path, params.target_path || params.music_adf?.output?.target_path)
    : undefined;

  return {
    status: 'succeeded' as const,
    action,
    prompt_id: promptId,
    artifacts,
    artifact: primaryArtifact || null,
    copied_to: copiedTo,
    compiled_generation_request: compiled?.resolved,
  };
}

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
  const { compiled, workflow } = preparePromptBasedGeneration(action, params);

  const result = await executeServicePreset('media-generation', action, {
    ...params,
    workflow,
  });

  const promptId = result?.prompt_id;
  if (!promptId) return result;

  const awaitCompletion =
    params.await_completion ??
    params.music_adf?.output?.await_completion ??
    Boolean(params.music_adf);

  if (awaitCompletion && !workflow) {
    throw new Error(`${action} requires params.workflow when await_completion is enabled`);
  }

  if (!awaitCompletion) {
    if (!compiled) return result;
    return {
      ...result,
      status: 'submitted',
      compiled_generation_request: compiled?.resolved,
    };
  }

  return collectGenerationResult(action, params, promptId, compiled);
}

async function submitGenerationJob(params: any) {
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
    },
    retry_policy: params.retry_policy || {
      max_attempts: 1,
      backoff_seconds: 0,
    },
    attempts: Number(params.next_attempt || 1),
    created_at: params.created_at || nowIso(),
    updated_at: nowIso(),
  };

  writeJob(job);
  return job;
}

async function getGenerationJob(params: any) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('get_generation_job requires job_id');
  const job = readJob(jobId);
  if (job.status === 'retrying') {
    return resumeRetriedGenerationJob(job);
  }
  if (isTerminalStatus(job.status)) return job;

  const promptId = String(job.provider?.prompt_id || '');
  if (!promptId) return job;

  try {
    const history = await secureFetch({
      method: 'GET',
      url: `${DEFAULT_COMFY_BASE_URL}/history/${promptId}`,
    });
    if (!history || Object.keys(history).length === 0 || !history[promptId]) {
      if (job.status !== 'running') {
        const runningJob = {
          ...job,
          status: 'running',
          updated_at: nowIso(),
        } as GenerationJob;
        return writeJob(runningJob);
      }
      return job;
    }

    const result = await collectGenerationResult(job.action, job.request || {}, promptId, { resolved: job.result?.compiled_generation_request });
    const succeededJob: GenerationJob = {
      ...job,
      status: 'succeeded',
      result: {
        ...job.result,
        artifact: result.artifact || undefined,
        artifacts: result.artifacts,
        copied_to: result.copied_to,
        compiled_generation_request: result.compiled_generation_request,
      },
      updated_at: nowIso(),
      completed_at: nowIso(),
    };
    return writeJob(succeededJob);
  } catch (error: any) {
    const failedJob: GenerationJob = {
      ...job,
      status: 'failed',
      result: {
        ...job.result,
        error: error.message,
      },
      updated_at: nowIso(),
      completed_at: nowIso(),
    };
    writeJob(failedJob);
    return retryGenerationJob(failedJob);
  }
}

async function waitGenerationJob(params: any) {
  const jobId = String(params.job_id || '');
  if (!jobId) throw new Error('wait_generation_job requires job_id');
  const timeoutMs = Number(params.timeout_ms || 15 * 60 * 1000);
  const pollIntervalMs = Number(params.poll_interval_ms || 5_000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const job = await getGenerationJob({ job_id: jobId });
    if (isTerminalStatus(job.status)) return job;
    await sleep(pollIntervalMs);
  }

  const timedOut = {
    ...readJob(jobId),
    status: 'timed_out',
    updated_at: nowIso(),
    completed_at: nowIso(),
    next_retry_at: undefined,
  } as GenerationJob;
  return writeJob(timedOut);
}

async function collectGenerationArtifact(params: any) {
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
  return updatedJob;
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
  logger.info(`🎬 [MEDIA-GEN:PROXY] Dispatching "${action}" to Service Engine...`);
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
  process.argv[1].endsWith('media-generation-actuator/src/index.ts') ||
  process.argv[1].endsWith('media-generation-actuator/dist/index.js') ||
  process.argv[1].endsWith('media-generation-actuator/src/index.js')
);

if (isMain) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
