import { describe, expect, it } from 'vitest';
import { parseTraceDetailResponse, parseTraceFeedResponse } from './trace-response';

const summary = {
  traceId: 'trace-1',
  tracePath: 'active/shared/logs/traces/traces-2026-09-01.jsonl',
  persistedAt: '2026-09-01T00:00:00.000Z',
  startedAt: '2026-09-01T00:00:00.000Z',
  status: 'ok',
  rootSpanName: 'pipeline:test',
  spanCount: 1,
  eventCount: 0,
  artifactCount: 0,
  errorCount: 0,
  rootSpan: {
    name: 'pipeline:test',
    status: 'ok',
    startTime: '2026-09-01T00:00:00.000Z',
    events: 0,
    artifacts: 0,
    children: 0,
  },
};

describe('trace response boundary', () => {
  it('accepts the feed contract and retains optional scope fields', () => {
    const result = parseTraceFeedResponse({
      traces: [{ ...summary, tenantSlug: 'tenant-a', tier: 'public' }],
      traceDir: 'active/shared/logs/traces',
    });
    expect(result?.traces[0]).toMatchObject({ tenantSlug: 'tenant-a', tier: 'public' });
  });

  it('rejects malformed feed records and dangerous root keys', () => {
    expect(
      parseTraceFeedResponse({ traces: [{ ...summary, errorCount: '0' }], traceDir: 'traces' })
    ).toBeUndefined();
    expect(
      parseTraceFeedResponse(JSON.parse('{"__proto__":{},"traces":[],"traceDir":"traces"}'))
    ).toBeUndefined();
  });

  it('accepts a detailed trace with recursively validated spans', () => {
    const result = parseTraceDetailResponse({
      trace: {
        ...summary,
        rootSpan: {
          name: 'pipeline:test',
          status: 'ok',
          startTime: '2026-09-01T00:00:00.000Z',
          events: [],
          artifacts: [],
          knowledgeRefs: [],
          children: [],
        },
      },
      traceDir: 'traces',
    });
    expect(result?.trace?.rootSpan.children).toEqual([]);
  });

  it('rejects malformed detail spans and preserves a null detail', () => {
    expect(
      parseTraceDetailResponse({
        trace: { ...summary, rootSpan: { ...summary.rootSpan, events: [] } },
        traceDir: 'traces',
      })
    ).toBeUndefined();
    expect(parseTraceDetailResponse({ trace: null, traceDir: 'traces' })).toEqual({
      trace: null,
      traceDir: 'traces',
    });
  });
});
