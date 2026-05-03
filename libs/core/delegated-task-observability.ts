import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir } from './secure-io.js';

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
}

const TRACE_PATH = pathResolver.shared('observability/delegations.jsonl');

function ensureTraceDir(): void {
  const traceDir = pathResolver.shared('observability');
  if (!safeExistsSync(traceDir)) {
    safeMkdir(traceDir, { recursive: true });
  }
}

function appendTrace(record: DelegatedTaskTrace): void {
  ensureTraceDir();
  safeAppendFileSync(TRACE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
}

export function startDelegatedTaskTrace(input: {
  owner: string;
  instruction: string;
  context?: string;
  contextRef?: string;
  backendName?: string;
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
  };
  appendTrace(trace);
  return trace;
}

export function completeDelegatedTaskTrace(
  trace: DelegatedTaskTrace,
  outcome: { resultSummary?: string; error?: string },
): DelegatedTaskTrace {
  const completed: DelegatedTaskTrace = {
    ...trace,
    completed_at: new Date().toISOString(),
    status: outcome.error ? 'failed' : 'completed',
    ...(outcome.resultSummary ? { result_summary: outcome.resultSummary } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
  appendTrace(completed);
  return completed;
}

