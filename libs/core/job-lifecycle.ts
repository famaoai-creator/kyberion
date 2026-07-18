import { sleep } from './async-utils.js';

export type CommonJobStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'canceled'
  | 'not_found'
  | 'timed_out';

export const TERMINAL_JOB_STATUSES = new Set<CommonJobStatus>([
  'completed',
  'succeeded',
  'failed',
  'cancelled',
  'canceled',
  'not_found',
  'timed_out',
]);

export interface CommonJobArtifactRef {
  path: string;
  kind?: string;
  media_type?: string;
}

export interface CommonJobReceipt<TStatus extends string = CommonJobStatus> {
  job_id: string;
  status: TStatus;
  created_at?: string;
  updated_at?: string;
  artifacts?: CommonJobArtifactRef[];
  error?: string;
  backend?: string;
}

export function isTerminalJobStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_JOB_STATUSES.has(status as CommonJobStatus);
}

export interface WaitForJobOptions<T> {
  getStatus: () => Promise<T>;
  isTerminal?: (value: T) => boolean;
  timeoutMs: number;
  pollIntervalMs?: number;
}

export interface WaitForJobResult<T> {
  status: 'completed' | 'timeout';
  value: T;
  elapsedMs: number;
}

export interface CancelJobOptions<T> extends WaitForJobOptions<T> {
  cancel: () => Promise<void>;
}

export async function cancelJob<T>({
  cancel,
  ...waitOptions
}: CancelJobOptions<T>): Promise<WaitForJobResult<T>> {
  await cancel();
  return waitForJob(waitOptions);
}

export async function waitForJob<T>({
  getStatus,
  isTerminal = (value) => isTerminalJobStatus((value as any)?.status),
  timeoutMs,
  pollIntervalMs = 250,
}: WaitForJobOptions<T>): Promise<WaitForJobResult<T>> {
  const startedAt = Date.now();
  let value = await getStatus();
  while (!isTerminal(value) && Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    value = await getStatus();
  }
  return {
    status: isTerminal(value) ? 'completed' : 'timeout',
    value,
    elapsedMs: Date.now() - startedAt,
  };
}
