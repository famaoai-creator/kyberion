/**
 * trace-exporter seam — the pluggable egress point for finalized traces.
 *
 * `persistTrace` (trace.ts) keeps the local day-rotated JSONL as the
 * authoritative, synchronous record. Every exporter registered here receives
 * the sanitized trace afterwards, asynchronously and best-effort: an exporter
 * failure is logged and never changes the pipeline outcome.
 *
 * Unlike a resolve-one seam (vcs-backend, event-bus) this is a FAN-OUT seam:
 * an operator may ship traces to an OTel collector and a vendor API at the
 * same time. Each exporter decides its own enablement (`isEnabled`, typically
 * "is my endpoint configured?"), and the governed policy
 * (`seam-provider-selection/trace-exporter.json` `default_chains.default`)
 * only fixes the delivery order — exporters outside the chain still run,
 * after the chained ones, in registration order. A saved seam default
 * (`KYBERION_SEAM_DEFAULTS="trace-exporter=<id>"` / scope layers) is delivered
 * to first; it never disables the other enabled exporters.
 *
 * Builtins: `otlp-http` (registered by trace.ts; enabled when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set). Datadog / CloudWatch / Sentry
 * adapters register through {@link registerTraceExporter} without touching
 * trace.ts. Audit entries are deliberately NOT routed here: the hash-chained
 * audit log has its own tamper-evident forwarder seam
 * (`governance/audit-forwarder.ts`).
 */

import { createProviderRegistry } from '../provider/provider-registry.js';
import type { SeamProviderMetadata } from '../seam.js';
import { resolveSeamDefaultOrder } from '../provider/seam-provider-selection.js';
import { createLogger } from '../logger.js';
import type { Trace } from './trace.js';

const logger = createLogger('trace-exporter');

export const TRACE_EXPORTER_SEAM = 'trace-exporter';
/** Builtin OTLP/HTTP JSON exporter id (registered by trace.ts). */
export const OTLP_HTTP_TRACE_EXPORTER_ID = 'otlp-http';

export interface TraceExporter {
  readonly id: string;
  /** Cheap, synchronous enablement check (e.g. endpoint env configured). */
  isEnabled(): boolean;
  /** Deliver one sanitized trace. Resolves `true` when it was sent. */
  export(trace: Trace): Promise<boolean>;
}

export interface TraceExportOutcome {
  id: string;
  status: 'exported' | 'skipped' | 'failed';
  error?: string;
}

const traceExporterRegistry = createProviderRegistry<TraceExporter>({
  seam: TRACE_EXPORTER_SEAM,
  owner: 'libs/core/analysis/trace-exporter.ts',
  source: 'trace-exporter-extension',
  missingIdError: 'TraceExporter must have a non-empty id',
});

export function registerTraceExporter(
  exporter: TraceExporter,
  metadata?: SeamProviderMetadata
): () => void {
  return traceExporterRegistry.register(exporter, metadata);
}

export function listTraceExporters(): TraceExporter[] {
  return traceExporterRegistry.list();
}

export function getTraceExporter(id: string): TraceExporter | undefined {
  return traceExporterRegistry.get(id);
}

export function resetTraceExporters(): void {
  traceExporterRegistry.reset();
}

/**
 * Registered exporters in delivery order: saved seam default first, then the
 * governed chain, then the rest in registration order.
 */
export function orderedTraceExporters(): TraceExporter[] {
  const registered = traceExporterRegistry.list();
  // A saved seam default only moves that exporter to the front of delivery;
  // it never disables the others (fan-out seam).
  const chain = resolveSeamDefaultOrder(TRACE_EXPORTER_SEAM, {
    builtin: [OTLP_HTTP_TRACE_EXPORTER_ID],
  });
  const ordered: TraceExporter[] = [];
  for (const id of chain) {
    const exporter = registered.find((candidate) => candidate.id === id);
    if (exporter) ordered.push(exporter);
  }
  for (const exporter of registered) {
    if (!ordered.includes(exporter)) ordered.push(exporter);
  }
  return ordered;
}

/**
 * Fan the trace out to every enabled exporter. Never throws: each failure is
 * captured in the returned outcome and logged at debug level, matching the
 * pre-seam `void exportTraceOtlp(...).catch(() => undefined)` contract.
 */
export async function exportTraceToBackends(trace: Trace): Promise<TraceExportOutcome[]> {
  const outcomes: TraceExportOutcome[] = [];
  for (const exporter of orderedTraceExporters()) {
    let enabled = false;
    try {
      enabled = exporter.isEnabled();
    } catch (err) {
      outcomes.push({ id: exporter.id, status: 'failed', error: errorText(err) });
      continue;
    }
    if (!enabled) {
      outcomes.push({ id: exporter.id, status: 'skipped' });
      continue;
    }
    try {
      const sent = await exporter.export(trace);
      outcomes.push({ id: exporter.id, status: sent ? 'exported' : 'skipped' });
    } catch (err) {
      const error = errorText(err);
      logger.debug(`trace export via ${exporter.id} failed: ${error}`);
      outcomes.push({ id: exporter.id, status: 'failed', error });
    }
  }
  return outcomes;
}

/** Recording exporter for hermetic tests; never registered by default. */
export function createMemoryTraceExporter(id = 'memory'): TraceExporter & {
  readonly traces: Trace[];
} {
  const traces: Trace[] = [];
  return {
    id,
    traces,
    isEnabled: () => true,
    async export(trace) {
      traces.push(trace);
      return true;
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
