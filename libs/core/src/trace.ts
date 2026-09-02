import { appendJsonLine } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
/**
 * Kyberion Trace Model
 * OpenTelemetry-inspired tracing with artifact and knowledge references.
 */

import { createHash, randomUUID } from 'crypto';
import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';
import * as pathResolver from '../path-resolver.js';
import { customerRoot, customerIsConfigured } from '../customer-resolver.js';
import { safeMkdir, safeExistsSync } from '../secure-io.js';
import { assertReasoningEgressAllowedAtEndpoint } from '../reasoning-egress-scope.js';
import {
  sanitizeTraceForPersistence,
  validateTraceReplay,
  type ExactTelemetryAttributes,
  type TraceSpanKind,
} from '../trace-schema.js';

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
  knowledgeRefs: string[]; // paths to related knowledge files
  children: TraceSpan[];
  error?: string;
}

export interface Trace {
  traceId: string;
  rootSpan: TraceSpan;
  metadata: {
    missionId?: string;
    correlationId?: string;
    actuator?: string;
    pipelineId?: string;
    startedAt: string;
    completedAt?: string;
    customerId?: string;
    tenantSlug?: string;
    /**
     * NI-02 actor attribution: canonical NHI id
     * (`kyberion://agent/<org>/<slug>`, see agent-identity.ts) of the agent
     * this trace's work is attributed to. Optional and purely additive.
     */
    actorNhiId?: string;
    /**
     * NI-02 actor attribution: who the actor is acting for — an nhi_id or a
     * `user:<id>` principal (delegation-chain vocabulary; full chains are
     * NI-03's scope).
     */
    onBehalfOf?: string;
  };
}

/**
 * Mutable context for building traces during pipeline execution.
 */
export class TraceContext {
  private trace: Trace;
  private spanStack: TraceSpan[];

  constructor(name: string, metadata?: Partial<Trace['metadata']>) {
    const correlationId =
      typeof metadata?.correlationId === 'string' && metadata.correlationId.trim().length > 0
        ? metadata.correlationId.trim()
        : undefined;
    const rootSpan: TraceSpan = {
      spanId: randomUUID(),
      name,
      startTime: nowIso(),
      status: 'in_progress',
      events: [],
      artifacts: [],
      knowledgeRefs: [],
      children: [],
    };
    const customer = getRegisteredEnvText('KYBERION_CUSTOMER')?.trim() || undefined;
    const tenant = getRegisteredEnvText('KYBERION_TENANT')?.trim() || undefined;
    this.trace = {
      traceId: randomUUID(),
      rootSpan,
      metadata: {
        startedAt: rootSpan.startTime,
        ...(customer ? { customerId: customer } : {}),
        ...(tenant ? { tenantSlug: tenant } : {}),
        ...metadata,
        ...(correlationId ? { correlationId } : {}),
      },
    };
    this.spanStack = [rootSpan];
  }

  /** Get the trace ID for correlation */
  get traceId(): string {
    return this.trace.traceId;
  }

  /** Get the current active span */
  private get currentSpan(): TraceSpan {
    return this.spanStack[this.spanStack.length - 1];
  }

  /** Start a new child span */
  startSpan<Name extends string>(
    name: Name,
    attributes?: Name extends TraceSpanKind
      ? ExactTelemetryAttributes<Extract<Name, TraceSpanKind>>
      : Record<string, string | number | boolean>
  ): string {
    const correlationId = this.trace.metadata.correlationId;
    const span: TraceSpan = {
      spanId: randomUUID(),
      name,
      startTime: nowIso(),
      status: 'in_progress',
      attributes: {
        ...(attributes || {}),
        ...(correlationId ? { correlationId } : {}),
      },
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
    span.endTime = nowIso();
    span.status = status;
    if (error) span.error = error;
  }

  /** Add an event to the current span */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const correlationId = this.trace.metadata.correlationId;
    this.currentSpan.events.push({
      name,
      timestamp: nowIso(),
      attributes: {
        ...(attributes || {}),
        ...(correlationId ? { correlationId } : {}),
      },
    });
  }

  /** Add an artifact reference to the current span */
  addArtifact(type: TraceArtifact['type'], path: string, description?: string): void {
    this.currentSpan.artifacts.push({
      type,
      path,
      description,
      timestamp: nowIso(),
    });
  }

  /** Add a knowledge reference to the current span */
  addKnowledgeRef(knowledgePath: string): void {
    this.currentSpan.knowledgeRefs.push(knowledgePath);
  }

  /**
   * Merge attributes onto the current span. Unlike `startSpan`'s
   * `attributes` argument (set once, at creation), this lets a caller record
   * outcome/result attributes discovered only after the span already exists
   * — e.g. a dispatch span whose `dispatched`/`result_schema_ok` flags are
   * only known once the work it wraps has resolved. Purely additive: merges
   * into any existing `attributes`, never removes keys.
   */
  setAttributes(attributes: Record<string, string | number | boolean>): void {
    this.currentSpan.attributes = { ...(this.currentSpan.attributes || {}), ...attributes };
  }

  /** Finalize the trace and return the immutable result */
  finalize(): Trace {
    // Close any open spans
    while (this.spanStack.length > 1) {
      this.endSpan('error', 'span not explicitly closed');
    }
    this.trace.rootSpan.endTime = nowIso();
    this.trace.rootSpan.status = this.trace.rootSpan.children.some((c) => c.status === 'error')
      ? 'error'
      : 'ok';
    this.trace.metadata.completedAt = this.trace.rootSpan.endTime;
    return this.trace;
  }

  /** Get a summary for logging */
  summary(): { traceId: string; spans: number; events: number; artifacts: number; errors: number } {
    const countSpans = (s: TraceSpan): number =>
      1 + s.children.reduce((sum, c) => sum + countSpans(c), 0);
    const countEvents = (s: TraceSpan): number =>
      s.events.length + s.children.reduce((sum, c) => sum + countEvents(c), 0);
    const countArtifacts = (s: TraceSpan): number =>
      s.artifacts.length + s.children.reduce((sum, c) => sum + countArtifacts(c), 0);
    const countErrors = (s: TraceSpan): number =>
      (s.status === 'error' ? 1 : 0) + s.children.reduce((sum, c) => sum + countErrors(c), 0);
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
  const replayIssues = validateTraceReplay(trace);
  if (replayIssues.length > 0) {
    throw new Error(
      `[TRACE_SCHEMA_INVALID] ${replayIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`
    );
  }
  const dir = opts?.dir ?? traceLogDir();
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const day = nowIso().slice(0, 10); // YYYY-MM-DD
  const file = path.join(dir, `traces-${day}.jsonl`);
  const safeTrace = sanitizeTraceForPersistence(trace);
  const record = { ...safeTrace, _persistedAt: nowIso() };
  appendJsonLine(file, record);
  // OTLP is explicitly opt-in. Local JSONL persistence remains synchronous
  // and authoritative; exporter failure must never change pipeline outcome.
  void exportTraceOtlp(safeTrace).catch(() => undefined);
  return file;
}

function otlpId(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function unixNano(iso: string | undefined): string {
  const ms = Date.parse(iso || nowIso());
  return (BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n).toString();
}

function otlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const entry of String(raw || '').split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

/** Export the stable Kyberion trace projection as OTLP/HTTP JSON when enabled. */
export async function exportTraceOtlp(trace: Trace): Promise<boolean> {
  const configured = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!configured) return false;
  const base = configured.replace(/\/$/u, '');
  const endpoint = /\/v1\/traces$/u.test(base) ? base : `${base}/v1/traces`;
  assertReasoningEgressAllowedAtEndpoint('otel', endpoint);
  const spans: Array<Record<string, unknown>> = [];
  const visit = (span: TraceSpan, parentSpanId?: string): void => {
    const spanId = otlpId(span.spanId, 16);
    spans.push({
      traceId: otlpId(trace.traceId, 32),
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: span.name,
      startTimeUnixNano: unixNano(span.startTime),
      endTimeUnixNano: unixNano(span.endTime || span.startTime),
      attributes: Object.entries({
        ...(trace.metadata.pipelineId ? { pipeline_id: trace.metadata.pipelineId } : {}),
        ...(trace.metadata.missionId ? { mission_id: trace.metadata.missionId } : {}),
        ...(span.attributes || {}),
      }).map(([key, value]) => ({
        key,
        value:
          typeof value === 'boolean'
            ? { boolValue: value }
            : typeof value === 'number'
              ? { intValue: value }
              : { stringValue: String(value) },
      })),
      events: span.events.map((event) => ({
        name: event.name,
        timeUnixNano: unixNano(event.timestamp),
        attributes: Object.entries(event.attributes || {}).map(([key, value]) => ({
          key,
          value:
            typeof value === 'boolean'
              ? { boolValue: value }
              : typeof value === 'number'
                ? { intValue: value }
                : { stringValue: String(value) },
        })),
      })),
      status: span.status === 'error' ? { code: 2, message: span.error } : { code: 1 },
    });
    for (const child of span.children) visit(child, spanId);
  };
  visit(trace.rootSpan);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: otlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'kyberion' } }] },
          scopeSpans: [{ scope: { name: 'kyberion.trace' }, spans }],
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OTLP export failed with HTTP ${response.status}`);
  return true;
}

/**
 * Convenience: finalize a TraceContext and persist it in one call.
 * Returns the finalized trace and the path it was written to.
 */
export function finalizeAndPersist(
  ctx: TraceContext,
  opts?: { dir?: string }
): { trace: Trace; path: string } {
  const trace = ctx.finalize();
  const p = persistTrace(trace, opts);
  return { trace, path: p };
}
