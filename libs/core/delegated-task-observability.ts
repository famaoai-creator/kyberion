import { randomUUID } from 'node:crypto';
import { logger } from './core.js';
import { enqueueDelegationNotification } from './delegation-notifications.js';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';

export interface DelegatedTaskTrace {
  trace_id: string;
  kind: 'delegated_task';
  created_at: string;
  completed_at?: string;
  status: 'started' | 'completed' | 'failed';
  owner: string;
  instruction: string;
  context?: string;
  context_ref?: string;
  backend_name?: string;
  result_summary?: string;
  error?: string;
  /** KC-06: background/async delegations notify the worker loop on completion. */
  background?: boolean;
  /** KC-06: set when this delegation resumed an earlier one by id. */
  resumed_from?: string;
  mission_id?: string;
  task_id?: string;
}

/**
 * KC-06: per-delegation persisted record. The append-only JSONL trace stays
 * the audit stream; this record is the resumable, id-addressable snapshot
 * (one JSON file per delegation) used by resume and by the post-compaction
 * active-task snapshot.
 */
export type DelegatedTaskRecord = Omit<DelegatedTaskTrace, 'trace_id'> & {
  delegation_id: string;
};

// Tests namespace the trace/store via KYBERION_DELEGATION_TRACE_PATH /
// KYBERION_DELEGATION_STORE_DIR so parallel suites never clobber the real
// observability files (resolved lazily per call).
function resolveTracePath(): string {
  const override = process.env.KYBERION_DELEGATION_TRACE_PATH?.trim();
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.shared('observability/delegations.jsonl');
}

function resolveStoreDir(): string {
  const override = process.env.KYBERION_DELEGATION_STORE_DIR?.trim();
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.shared('observability/delegations');
}

function ensureTraceDir(): void {
  const traceDir = resolveTracePath().replace(/[/\\][^/\\]+$/, '');
  if (!safeExistsSync(traceDir)) {
    safeMkdir(traceDir, { recursive: true });
  }
}

function appendTrace(record: DelegatedTaskTrace): void {
  ensureTraceDir();
  safeAppendFileSync(resolveTracePath(), `${JSON.stringify(record)}\n`, 'utf8');
}

function recordPath(delegationId: string): string {
  const safeId = String(delegationId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!safeId) throw new Error('Delegation id is required.');
  return `${resolveStoreDir()}/${safeId}.json`;
}

function persistRecord(trace: DelegatedTaskTrace): void {
  try {
    const dir = resolveStoreDir();
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    const { trace_id, ...rest } = trace;
    const record: DelegatedTaskRecord = { delegation_id: trace_id, ...rest };
    safeWriteFile(recordPath(trace_id), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    // The persisted record is a resumability aid — never fail the delegation.
    logger.warn(
      `[delegated-task] record persistence failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function startDelegatedTaskTrace(input: {
  owner: string;
  instruction: string;
  context?: string;
  contextRef?: string;
  backendName?: string;
  /** KC-06: background delegations enqueue a claim-based notification on completion. */
  background?: boolean;
  resumedFrom?: string;
  missionId?: string;
  taskId?: string;
}): DelegatedTaskTrace {
  const trace: DelegatedTaskTrace = {
    trace_id: randomUUID(),
    kind: 'delegated_task',
    created_at: new Date().toISOString(),
    status: 'started',
    owner: input.owner,
    instruction: input.instruction,
    ...(input.context ? { context: input.context } : {}),
    ...(input.contextRef ? { context_ref: input.contextRef } : {}),
    ...(input.backendName ? { backend_name: input.backendName } : {}),
    ...(input.background ? { background: true } : {}),
    ...(input.resumedFrom ? { resumed_from: input.resumedFrom } : {}),
    ...(input.missionId ? { mission_id: input.missionId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
  };
  appendTrace(trace);
  persistRecord(trace);
  return trace;
}

export function completeDelegatedTaskTrace(
  trace: DelegatedTaskTrace,
  outcome: { resultSummary?: string; error?: string }
): DelegatedTaskTrace {
  const completed: DelegatedTaskTrace = {
    ...trace,
    completed_at: new Date().toISOString(),
    status: outcome.error ? 'failed' : 'completed',
    ...(outcome.resultSummary ? { result_summary: outcome.resultSummary } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
  appendTrace(completed);
  persistRecord(completed);
  if (completed.background) {
    // KC-06: background completions are delivered into the running worker's
    // context via the claim-based notification queue — best-effort only.
    try {
      enqueueDelegationNotification({
        delegationId: completed.trace_id,
        owner: completed.owner,
        ...(completed.mission_id ? { missionId: completed.mission_id } : {}),
        ...(completed.task_id ? { taskId: completed.task_id } : {}),
        status: completed.status === 'failed' ? 'failed' : 'completed',
        instruction: completed.instruction,
        result: completed.result_summary,
        error: completed.error,
        completedAt: completed.completed_at,
      });
    } catch (error) {
      logger.warn(
        `[delegated-task] completion notification enqueue failed (non-fatal): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return completed;
}

export function loadDelegatedTaskRecord(delegationId: string): DelegatedTaskRecord | null {
  try {
    const filePath = recordPath(delegationId);
    if (!safeExistsSync(filePath)) return null;
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as DelegatedTaskRecord;
    return parsed && typeof parsed.delegation_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Still-running delegations (status `started`), newest first. Feeds the
 * post-compaction active-task snapshot (bounded by `limit`).
 */
export function listActiveDelegatedTaskRecords(limit = 8): DelegatedTaskRecord[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const dir = resolveStoreDir();
  if (!safeExistsSync(dir)) return [];
  const records: DelegatedTaskRecord[] = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.json')) continue;
    const record = loadDelegatedTaskRecord(entry.slice(0, -'.json'.length));
    if (record?.status === 'started') records.push(record);
  }
  return records
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, boundedLimit);
}

/**
 * KC-06: resume a completed (or still-open) delegation by id — the stored
 * instruction and result are embedded as context for a fresh delegateTask
 * carrying the follow-up instruction.
 *
 * KD-05: when a subagent (rather than the owning worker itself) initiates
 * the resume, callers pass `requestedBy` so this function can verify the
 * requester actually owns the delegation — the Kyberion-side equivalent of
 * kimi-code's `ensureOwnedIdleSubagent`. A still-running delegation
 * (`status: 'started'`) is always rejected regardless of `requestedBy`: two
 * concurrent resumes of the same in-flight delegation is a race no caller
 * should be relying on.
 */
export async function resumeDelegatedTask(
  delegationId: string,
  followUpInstruction: string,
  options: {
    backend?: { delegateTask(instruction: string, context?: string): Promise<string> };
    owner?: string;
    /** KD-05: identity attempting the resume, checked against record.owner. */
    requestedBy?: string;
  } = {}
): Promise<{ result: string; trace: DelegatedTaskTrace; record: DelegatedTaskRecord }> {
  const record = loadDelegatedTaskRecord(delegationId);
  if (!record) {
    throw new Error(`Delegated task record not found for id "${delegationId}".`);
  }
  if (record.status === 'started') {
    throw new Error(
      `Delegated task "${delegationId}" is still running; resume is rejected until it completes or fails.`
    );
  }
  if (options.requestedBy && options.requestedBy !== record.owner) {
    throw new Error(
      `Delegated task "${delegationId}" is owned by "${record.owner}"; resume rejected for requester "${options.requestedBy}".`
    );
  }
  const backend = options.backend ?? (await import('./reasoning-backend.js')).getReasoningBackend();
  const prompt = [
    'You previously executed a delegated task. Resume it with the follow-up below;',
    'do not restart the original work from scratch.',
    '',
    'Original instruction:',
    record.instruction,
    '',
    'Previous result:',
    record.result_summary ||
      (record.error
        ? `The previous attempt failed: ${record.error}`
        : '(no result recorded yet — the task may still be running)'),
    '',
    'Follow-up instruction:',
    followUpInstruction,
  ].join('\n');
  const trace = startDelegatedTaskTrace({
    owner: options.owner || record.owner,
    instruction: prompt,
    ...(record.context ? { context: record.context } : {}),
    ...(record.context_ref ? { contextRef: record.context_ref } : {}),
    resumedFrom: record.delegation_id,
    ...(record.mission_id ? { missionId: record.mission_id } : {}),
    ...(record.task_id ? { taskId: record.task_id } : {}),
  });
  try {
    const result = await backend.delegateTask(prompt, record.context);
    const completed = completeDelegatedTaskTrace(trace, { resultSummary: result });
    return { result, trace: completed, record };
  } catch (error) {
    completeDelegatedTaskTrace(trace, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function delegatedTaskStoreDir(): string {
  return resolveStoreDir();
}
