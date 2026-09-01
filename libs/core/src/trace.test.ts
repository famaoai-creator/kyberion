import { afterEach, describe, expect, it } from 'vitest';
import { exportTraceOtlp, finalizeAndPersist, persistTrace, TraceContext } from './trace.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync } from '../secure-io.js';
import { validateTraceReplay } from '../trace-schema.js';

const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalFetch = globalThis.fetch;
const traceTestDir = pathResolver.sharedTmp(`trace-schema-replay-${process.pid}`);

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
  globalThis.fetch = originalFetch;
  safeRmSync(traceTestDir, { recursive: true, force: true });
});

describe('trace OTLP bridge', () => {
  it('type-checks exact attributes for governed span names', () => {
    const context = new TraceContext('workflow.test');
    context.startSpan('mission', { mission_id: 'M1' });
    // @ts-expect-error governed span attributes reject undeclared keys
    context.startSpan('mission', { undeclared: true });
    context.endSpan('ok');
  });

  it('is disabled unless an OTLP endpoint is configured', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const trace = new TraceContext('workflow.test').finalize();
    expect(await exportTraceOtlp(trace)).toBe(false);
  });

  it('projects nested Kyberion spans into OTLP/HTTP JSON', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    let request: { url: string; body: string } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { url: String(input), body: String(init?.body || '') };
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const context = new TraceContext('workflow.test', { pipelineId: 'p-test' });
    context.startSpan('step.judge');
    context.addEvent('judge.route_selected', { matched: true });
    context.endSpan('ok');
    const trace = context.finalize();

    expect(await exportTraceOtlp(trace)).toBe(true);
    expect(request?.url).toBe('http://127.0.0.1:4318/v1/traces');
    const body = JSON.parse(request?.body || '{}');
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    expect(body.resourceSpans[0].scopeSpans[0].spans[1].name).toBe('step.judge');
  });

  it('validates persisted traces at the write boundary and replays the persisted record', () => {
    const persisted = finalizeAndPersist(new TraceContext('workflow.replay'), {
      dir: traceTestDir,
    });
    const record = JSON.parse(
      String(safeReadFile(persisted.path, { encoding: 'utf8' })).trim()
    ) as unknown;
    expect(validateTraceReplay(record)).toEqual([]);

    const malformed = {
      traceId: 'trace-invalid',
      rootSpan: {
        name: 'workflow.replay',
        status: 'invalid',
        events: [],
        children: [],
      },
    };
    expect(() => persistTrace(malformed as never, { dir: traceTestDir })).toThrow(
      '[TRACE_SCHEMA_INVALID]'
    );
  });
});
