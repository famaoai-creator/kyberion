import AjvModule from 'ajv';
import {
  compileSchemaFromPath,
  logger,
  pathResolver,
  safeReadFile,
  classifyError,
  VideoRenderRuntime,
} from '@agent/core';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
export const videoCompositionActionValidate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/video-composition-action.schema.json'));
export const VIDEO_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/video-composition-actuator/manifest.json');
export const DEFAULT_VIDEO_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

export const runtime = new VideoRenderRuntime();
export const packetHistory = new Map<string, any[]>();
export const jobDiagnostics = new Map<string, VideoCompositionJobDiagnostics>();

export interface VideoCompositionJobDiagnostics {
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

export function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(VIDEO_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
  } catch {
    cachedRecoveryPolicy = {};
  }
  return cachedRecoveryPolicy;
}

export function buildRetryOptions(defaultRetry: Record<string, any>) {
  const policy = loadRecoveryPolicy();
  const retry = isPlainObject(policy.retry) ? policy.retry : defaultRetry;
  const retryableCategories = new Set<string>(
    Array.isArray(policy.retryable_categories) ? policy.retryable_categories.map(String) : [],
  );
  return {
    ...defaultRetry,
    ...retry,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      return retryableCategories.size > 0
        ? retryableCategories.has(classification.category)
        : classification.category === 'resource_unavailable' || classification.category === 'timeout';
    },
  };
}

export function deepResolve(val: any, ctx: any): any {
  if (typeof val === 'string') {
    return val.replace(/{{(.*?)}}/g, (_, p) => {
      const key = String(p).split('|')[0].trim();
      const parts = key.split('.');
      let current = ctx;
      for (const part of parts) {
        current = current?.[part];
      }
      return current !== undefined ? String(current) : '';
    });
  }
  if (Array.isArray(val)) return val.map((item) => deepResolve(item, ctx));
  if (val !== null && typeof val === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) result[k] = deepResolve(v, ctx);
    return result;
  }
  return val;
}

export function resolveActionParams(input: Record<string, any>): Record<string, any> {
  if (isPlainObject(input.params)) {
    return input.params;
  }
  const params = { ...input };
  delete (params as any).action;
  delete (params as any).kind;
  delete (params as any).type;
  return params;
}

export function validateVideoCompositionAction(input: unknown): void {
  const ok = videoCompositionActionValidate(input);
  if (ok) return;
  const detail = (videoCompositionActionValidate.errors || [])
    .map((error: any) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`Invalid video composition action: ${detail}`);
}

export function resolveAwaitCompletion(adf: { output?: { await_completion?: boolean } }, policy: { render?: { enable_backend_rendering?: boolean } }): boolean {
  if (adf.output?.await_completion === true) return true;
  if (adf.output?.await_completion === false) return false;
  return !policy.render?.enable_backend_rendering;
}

export function computeAwaitTimeoutMs(policy: { render?: { command_timeout_ms?: number } }): number {
  return Math.max(30_000, Number(policy.render?.command_timeout_ms || 0) + 60_000);
}

export function normalizeAwaitTimeoutMs(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 30_000;
  return Math.max(10, Math.min(3_600_000, Math.floor(raw)));
}

export function upsertJobDiagnostics(jobId: string, patch: Partial<VideoCompositionJobDiagnostics>): VideoCompositionJobDiagnostics {
  const current = jobDiagnostics.get(jobId) || {};
  const next = { ...current, ...patch };
  jobDiagnostics.set(jobId, next);
  return next;
}

export function trackLifecycleDiagnostics(packet: any): void {
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

export function extractBackendTerminationState(error: any): Partial<VideoCompositionJobDiagnostics> | null {
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

export function formatCancellationMessage(jobId: string): string {
  const diagnostic = jobDiagnostics.get(jobId);
  const reason = diagnostic?.cancellation_reason;
  const signal = diagnostic?.backend_exit_signal;
  if (reason && signal) return `cancelled: ${reason} (backend signal=${signal})`;
  if (reason) return `cancelled: ${reason}`;
  if (signal) return `cancelled (backend signal=${signal})`;
  return 'cancelled';
}

export async function waitForRenderJob(
  runtime: typeof import('./video-composition-helpers.js').runtime,
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
