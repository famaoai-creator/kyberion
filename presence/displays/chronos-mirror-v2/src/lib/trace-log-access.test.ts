import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';

import { filterTraceLogContent, isAllowedTraceLogPath, traceLogRoots } from './trace-log-access';

describe('trace-log-access', () => {
  it('allows trace logs under the shared trace log root', () => {
    const sharedPath = pathResolver.shared('logs/traces/traces-2026-05-28.jsonl');
    expect(isAllowedTraceLogPath(sharedPath)).toBe(true);
  });

  it('rejects non-trace-log paths', () => {
    expect(isAllowedTraceLogPath(pathResolver.shared('logs/audit/audit.log'))).toBe(false);
  });

  it('exposes at least one trace log root', () => {
    expect(traceLogRoots().length).toBeGreaterThan(0);
  });

  it('filters raw JSONL records by tenant and tier', () => {
    const trace = (traceId: string, tenantSlug: string | undefined, tier: string | undefined) => ({
      traceId,
      metadata: { tenantSlug, tier },
      rootSpan: {
        spanId: `${traceId}-span`,
        name: `pipeline:${traceId}`,
        status: 'ok',
        startTime: '2026-05-28T15:59:00.000Z',
        events: [],
        artifacts: [],
        knowledgeRefs: [],
        children: [],
      },
    });
    const content = [
      trace('public-a', 'tenant-a', 'public'),
      trace('personal-a', 'tenant-a', 'personal'),
      trace('public-b', 'tenant-b', 'public'),
      trace('legacy', undefined, undefined),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');

    const filtered = filterTraceLogContent(content, 'traces-2026-05-28.jsonl', {
      tenantSlugs: ['tenant-a'],
      tierAccess: ['public', 'confidential'],
    });
    expect(filtered).toContain('public-a');
    expect(filtered).not.toContain('personal-a');
    expect(filtered).not.toContain('public-b');
    expect(filtered).not.toContain('legacy');
  });
});
