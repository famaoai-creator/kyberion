/**
 * Worker event stream (KC-02).
 *
 * A single typed envelope for everything a worker/pipeline run does, projected
 * onto a single-producer/multi-consumer broadcast channel. Consumers subscribe
 * for UI, recording (jsonl replay), or e2e assertions ("prompt in → expected
 * event sequence out"); the existing Trace/observation writers stay untouched
 * and can be attached as one more subscriber. Modeled on kimi-cli's Wire
 * (SPMC broadcast + wire.jsonl recorder), with Kyberion vocabulary added.
 */

import { z } from 'zod';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { resolveSharedObservabilityDir } from './observability-gate.js';
import { safeAppendFileSync, safeMkdir, safeReadFile } from './secure-io.js';

export const WORKER_EVENT_TYPES = [
  // turn/run lifecycle
  'turn_begin',
  'turn_end',
  'step_begin',
  'step_end',
  // context economy (OH-01)
  'compaction_begin',
  'compaction_end',
  'context_rewind',
  // status/usage
  'status_update',
  // delegation
  'subagent_begin',
  'subagent_end',
  // governance
  'approval_request',
  'approval_response',
  'governance_action',
  // operator/user-facing
  'notification',
  // mission orchestration (Kyberion vocabulary)
  'mission_event',
  'phase_begin',
  'phase_end',
  'gate_evaluated',
] as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

export const workerEventSourceSchema = z
  .object({
    mission_id: z.string().optional(),
    task_id: z.string().optional(),
    agent_id: z.string().optional(),
    pipeline_id: z.string().optional(),
  })
  .strict();

export const workerEventEnvelopeSchema = z
  .object({
    type: z.enum(WORKER_EVENT_TYPES),
    ts: z.string(),
    seq: z.number().int().nonnegative(),
    source: workerEventSourceSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type WorkerEventSource = z.infer<typeof workerEventSourceSchema>;
export type WorkerEventEnvelope = z.infer<typeof workerEventEnvelopeSchema>;

export type WorkerEventListener = (event: WorkerEventEnvelope) => void;

export class WorkerEventStream {
  private readonly listeners = new Set<WorkerEventListener>();
  private seq = 0;
  private readonly defaultSource: WorkerEventSource | undefined;

  constructor(defaultSource?: WorkerEventSource) {
    this.defaultSource = defaultSource;
  }

  subscribe(listener: WorkerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Build, validate and broadcast an envelope. Listener failures are isolated
   * (fail-open): a broken consumer must never stop the worker.
   */
  emit(
    type: WorkerEventType,
    payload: Record<string, unknown> = {},
    source?: WorkerEventSource
  ): WorkerEventEnvelope {
    const mergedSource = source ?? this.defaultSource;
    const envelope: WorkerEventEnvelope = workerEventEnvelopeSchema.parse({
      type,
      ts: new Date().toISOString(),
      seq: this.seq++,
      ...(mergedSource && Object.keys(mergedSource).length > 0 ? { source: mergedSource } : {}),
      payload,
    });
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch (err) {
        logger.warn(
          `[worker-event-stream] listener failed for ${type}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return envelope;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Append every envelope to a jsonl file; returns the detach function. */
export function attachJsonlRecorder(stream: WorkerEventStream, filePath: string): () => void {
  return stream.subscribe((event) => {
    safeAppendFileSync(filePath, `${JSON.stringify(event)}\n`);
  });
}

/** Parse a recorded jsonl file back into validated envelopes (replay). */
export function readWorkerEventStreamJsonl(filePath: string): WorkerEventEnvelope[] {
  const raw = String(safeReadFile(filePath, { encoding: 'utf-8' }));
  const events: WorkerEventEnvelope[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(workerEventEnvelopeSchema.parse(JSON.parse(trimmed)));
    } catch {
      // A torn/corrupt line must not poison replay of the rest.
    }
  }
  return events;
}

const GLOBAL_KEY = Symbol.for('kyberion.workerEventStream');

/**
 * Process-wide default stream. Governed writers (approval gate, orchestration
 * observations, pipeline runner) publish here so any surface can subscribe
 * without threading a stream instance through every call site.
 */
export function getDefaultWorkerEventStream(): WorkerEventStream {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[GLOBAL_KEY]) {
    const stream = new WorkerEventStream();
    holder[GLOBAL_KEY] = stream;
    attachDefaultObservabilityRecorder(stream);
  }
  return holder[GLOBAL_KEY] as WorkerEventStream;
}

/** Test seam: replace/reset the process-wide stream. */
export function resetDefaultWorkerEventStream(): void {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
}

function attachDefaultObservabilityRecorder(stream: WorkerEventStream): void {
  try {
    const realDir = pathResolver.shared('observability/worker-events');
    const dir = resolveSharedObservabilityDir(realDir);
    if (!dir) return;
    safeMkdir(dir);
    const day = new Date().toISOString().slice(0, 10);
    attachJsonlRecorder(stream, `${dir}/worker-events-${day}.jsonl`);
  } catch {
    // Observability wiring is best-effort; never block stream creation.
  }
}

/**
 * Bridge ADF engine step hooks onto a stream, composable with existing hooks.
 * Emits step_begin/step_end around each engine step (nested steps included).
 */
export function buildWorkerEventStepHooks(
  stream: WorkerEventStream,
  source?: WorkerEventSource
): {
  beforeStep: (step: { op: string; type?: string }, stepNumber: number) => void;
  afterStep: (
    step: { op: string; type?: string },
    stepNumber: number,
    outcome: { status: string; error?: string }
  ) => void;
} {
  return {
    beforeStep: (step, stepNumber) => {
      stream.emit('step_begin', { op: step.op, step_number: stepNumber }, source);
    },
    afterStep: (step, stepNumber, outcome) => {
      stream.emit(
        'step_end',
        {
          op: step.op,
          step_number: stepNumber,
          status: outcome.status,
          ...(outcome.error ? { error: outcome.error } : {}),
        },
        source
      );
    },
  };
}
