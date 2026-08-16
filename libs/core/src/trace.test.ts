import { afterEach, describe, expect, it } from 'vitest';
import { exportTraceOtlp, TraceContext } from './trace.js';

const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
  globalThis.fetch = originalFetch;
});

describe('trace OTLP bridge', () => {
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
});
