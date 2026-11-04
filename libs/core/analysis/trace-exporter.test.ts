import { afterEach, describe, expect, it } from 'vitest';
import { TraceContext } from './trace.js';
import {
  OTLP_HTTP_TRACE_EXPORTER_ID,
  createMemoryTraceExporter,
  exportTraceToBackends,
  getTraceExporter,
  orderedTraceExporters,
  registerTraceExporter,
} from './trace-exporter.js';

const cleanups: Array<() => void> = [];
const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
});

describe('trace-exporter seam', () => {
  it('registers the builtin otlp-http exporter, disabled without an endpoint', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const otlp = getTraceExporter(OTLP_HTTP_TRACE_EXPORTER_ID);
    expect(otlp).toBeDefined();
    expect(otlp!.isEnabled()).toBe(false);
    const outcomes = await exportTraceToBackends(new TraceContext('workflow.test').finalize());
    expect(outcomes.find((o) => o.id === OTLP_HTTP_TRACE_EXPORTER_ID)?.status).toBe('skipped');
  });

  it('fans out to every enabled exporter, governed chain first', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const a = createMemoryTraceExporter('memory-a');
    const b = createMemoryTraceExporter('memory-b');
    cleanups.push(registerTraceExporter(a), registerTraceExporter(b));
    const ids = orderedTraceExporters().map((e) => e.id);
    expect(ids[0]).toBe(OTLP_HTTP_TRACE_EXPORTER_ID);
    expect(ids.indexOf('memory-a')).toBeLessThan(ids.indexOf('memory-b'));

    const trace = new TraceContext('workflow.test').finalize();
    const outcomes = await exportTraceToBackends(trace);
    expect(a.traces).toEqual([trace]);
    expect(b.traces).toEqual([trace]);
    expect(outcomes.filter((o) => o.status === 'exported').map((o) => o.id)).toEqual([
      'memory-a',
      'memory-b',
    ]);
  });

  it('isolates exporter failures — later exporters still receive the trace', async () => {
    const recorder = createMemoryTraceExporter('memory-after-failure');
    cleanups.push(
      registerTraceExporter({
        id: 'always-fails',
        isEnabled: () => true,
        export: async () => {
          throw new Error('collector down');
        },
      }),
      registerTraceExporter(recorder)
    );
    const outcomes = await exportTraceToBackends(new TraceContext('workflow.test').finalize());
    expect(outcomes.find((o) => o.id === 'always-fails')).toMatchObject({
      status: 'failed',
      error: 'collector down',
    });
    expect(recorder.traces).toHaveLength(1);
  });
});
