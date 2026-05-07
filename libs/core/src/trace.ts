/**
 * Kyberion Trace Model
 * OpenTelemetry-inspired tracing with artifact and knowledge references.
 */

import { randomUUID } from 'crypto';
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { customerRoot, customerIsConfigured } from '../customer-resolver.js';
import { safeMkdir, safeAppendFileSync, safeExistsSync } from '../secure-io.js';

export interface TraceEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceArtifact {
  type: 'screenshot' | 'file' | 'document' | 'log';
  path: string;
  description?: string;
  timestamp: string;
}

export interface TraceSpan {
  spanId: string;
  name: string;
  startTime: string;
  endTime?: string;
  status: 'ok' | 'error' | 'in_progress';
  attributes?: Record<string, string | number | boolean>;
  events: TraceEvent[];
  artifacts: TraceArtifact[];
  knowledgeRefs: string[];     // paths to related knowledge files
  children: TraceSpan[];
  error?: string;
}

export interface Trace {
  traceId: string;
  rootSpan: TraceSpan;
  metadata: {
    missionId?: string;
    actuator?: string;
    pipelineId?: string;
    startedAt: string;
    completedAt?: string;
  };
}

/**
 * Mutable context for building traces during pipeline execution.
 */
export class TraceContext {
  private trace: Trace;
  private spanStack: TraceSpan[];

  constructor(name: string, metadata?: Partial<Trace['metadata']>) {
    const rootSpan: TraceSpan = {
      spanId: randomUUID(),
      name,
      startTime: new Date().toISOString(),
      status: 'in_progress',
      events: [],
      artifacts: [],
      knowledgeRefs: [],
      children: [],
    };
    this.trace = {
      traceId: randomUUID(),
      rootSpan,
      metadata: {
        startedAt: rootSpan.startTime,
        ...metadata,
      },
    };
    this.spanStack = [rootSpan];
  }

  /** Get the trace ID for correlation */
  get traceId(): string { return this.trace.traceId; }

  /** Get the current active span */
  private get currentSpan(): TraceSpan {
    return this.spanStack[this.spanStack.length - 1];
  }

  /** Start a new child span */
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): string {
    const span: TraceSpan = {
      spanId: randomUUID(),
      name,
      startTime: new Date().toISOString(),
      status: 'in_progress',
      attributes,
      events: [],
      artifacts: [],
      knowledgeRefs: [],
      children: [],
    };
    this.currentSpan.children.push(span);
    this.spanStack.push(span);
    return span.spanId;
  }

  /** End the current span */
  endSpan(status: 'ok' | 'error' = 'ok', error?: string): void {
    if (this.spanStack.length <= 1) return; // don't pop root
    const span = this.spanStack.pop()!;
    span.endTime = new Date().toISOString();
    span.status = status;
    if (error) span.error = error;
  }

  /** Add an event to the current span */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    this.currentSpan.events.push({
      name,
      timestamp: new Date().toISOString(),
      attributes,
    });
  }

  /** Add an artifact reference to the current span */
  addArtifact(type: TraceArtifact['type'], path: string, description?: string): void {
    this.currentSpan.artifacts.push({
      type,
      path,
      description,
      timestamp: new Date().toISOString(),
    });
  }

  /** Add a knowledge reference to the current span */
  addKnowledgeRef(knowledgePath: string): void {
    this.currentSpan.knowledgeRefs.push(knowledgePath);
  }

  /** Finalize the trace and return the immutable result */
  finalize(): Trace {
    // Close any open spans
    while (this.spanStack.length > 1) {
      this.endSpan('error', 'span not explicitly closed');
    }
    this.trace.rootSpan.endTime = new Date().toISOString();
    this.trace.rootSpan.status =
      this.trace.rootSpan.children.some(c => c.status === 'error') ? 'error' : 'ok';
    this.trace.metadata.completedAt = this.trace.rootSpan.endTime;
    return this.trace;
  }

  /** Get a summary for logging */
  summary(): { traceId: string; spans: number; events: number; artifacts: number; errors: number } {
    const countSpans = (s: TraceSpan): number => 1 + s.children.reduce((sum, c) => sum + countSpans(c), 0);
    const countEvents = (s: TraceSpan): number => s.events.length + s.children.reduce((sum, c) => sum + countEvents(c), 0);
    const countArtifacts = (s: TraceSpan): number => s.artifacts.length + s.children.reduce((sum, c) => sum + countArtifacts(c), 0);
    const countErrors = (s: TraceSpan): number => (s.status === 'error' ? 1 : 0) + s.children.reduce((sum, c) => sum + countErrors(c), 0);
    return {
      traceId: this.trace.traceId,
      spans: countSpans(this.trace.rootSpan),
      events: countEvents(this.trace.rootSpan),
      artifacts: countArtifacts(this.trace.rootSpan),
      errors: countErrors(this.trace.rootSpan),
    };
  }
}

/**
 * Resolve the directory where traces should be persisted as JSONL.
 * - When KYBERION_CUSTOMER is active: customer/{slug}/logs/traces/
 * - Otherwise: active/shared/logs/traces/
 *
 * Creates the directory if it does not exist.
 */
export function traceLogDir(): string {
  let baseDir: string;
  if (customerIsConfigured()) {
    baseDir = path.join(customerRoot('logs/traces')!);
  } else {
    baseDir = path.join(pathResolver.shared('logs/traces'));
  }
  if (!safeExistsSync(baseDir)) safeMkdir(baseDir, { recursive: true });
  return baseDir;
}

/**
 * Persist a finalized Trace as a single JSONL line for the calendar day.
 * Returns the path of the file the trace was appended to.
 *
 * Format: one JSON object per line ({...trace, _persistedAt}).
 * The day-rotated file makes it cheap for downstream tools (e.g. Chronos viewer)
 * to scan recent activity without parsing the whole history.
 */
export function persistTrace(trace: Trace, opts?: { dir?: string }): string {
  const dir = opts?.dir ?? traceLogDir();
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const file = path.join(dir, `traces-${day}.jsonl`);
  const record = { ...trace, _persistedAt: new Date().toISOString() };
  safeAppendFileSync(file, JSON.stringify(record) + '\n');
  return file;
}

/**
 * Convenience: finalize a TraceContext and persist it in one call.
 * Returns the finalized trace and the path it was written to.
 */
export function finalizeAndPersist(
  ctx: TraceContext,
  opts?: { dir?: string },
): { trace: Trace; path: string } {
  const trace = ctx.finalize();
  const p = persistTrace(trace, opts);
  return { trace, path: p };
}
