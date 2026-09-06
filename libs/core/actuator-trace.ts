import { logger } from './core.js';
import { type Trace, TraceContext, persistTrace } from './src/trace.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createActuatorTrace(
  actuator: string,
  action: string,
  metadata?: Partial<Trace['metadata']> & Record<string, string | number | boolean>
): TraceContext {
  return new TraceContext(`${actuator}:${action}`, {
    actuator,
    ...metadata,
  });
}

export function finalizeActuatorTrace(traceCtx: TraceContext): {
  trace: Trace;
  trace_summary: ReturnType<TraceContext['summary']>;
  trace_persisted_path?: string;
} {
  const trace = traceCtx.finalize();
  const trace_summary = traceCtx.summary();
  try {
    const trace_persisted_path = persistTrace(trace);
    return { trace, trace_summary, trace_persisted_path };
  } catch (err: unknown) {
    logger.warn(`[trace] Failed to persist actuator trace: ${errorMessage(err)}`);
    return { trace, trace_summary };
  }
}
