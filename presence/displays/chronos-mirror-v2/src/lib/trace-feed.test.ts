import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

import { collectTraceDetail, collectTraceFeed, summarizePersistedTrace } from './trace-feed';

const TEST_DIR = pathResolver.sharedTmp('chronos-trace-feed-test');

function resetTestDir(): void {
  safeRmSync(TEST_DIR, { recursive: true, force: true });
  safeMkdir(TEST_DIR, { recursive: true });
}

afterEach(() => {
  safeRmSync(TEST_DIR, { recursive: true, force: true });
});

describe('trace-feed', () => {
  it('summarizes a persisted trace record', () => {
    const summary = summarizePersistedTrace(
      {
        traceId: 'trace-1',
        _persistedAt: '2026-05-28T15:00:00.000Z',
        metadata: {
          missionId: 'MSN-1',
          actuator: 'media-generation-actuator',
          pipelineId: 'pipeline-1',
          startedAt: '2026-05-28T14:59:00.000Z',
          completedAt: '2026-05-28T15:00:00.000Z',
        },
        rootSpan: {
          name: 'root',
          status: 'ok',
          startTime: '2026-05-28T14:59:00.000Z',
          endTime: '2026-05-28T15:00:00.000Z',
          events: [{ name: 'step' }],
          artifacts: [{ path: '/tmp/artifact.png' }],
          children: [
            {
              name: 'child',
              status: 'error',
              startTime: '2026-05-28T14:59:10.000Z',
              events: [{ name: 'child-step' }],
              artifacts: [],
              children: [],
            },
          ],
        },
      },
      'active/shared/logs/traces/traces-2026-05-28.jsonl'
    );

    expect(summary?.traceId).toBe('trace-1');
    expect(summary?.spanCount).toBe(2);
    expect(summary?.eventCount).toBe(2);
    expect(summary?.artifactCount).toBe(1);
    expect(summary?.errorCount).toBe(1);
    expect(summary?.missionId).toBe('MSN-1');
  });

  it('collects traces from the provided directory and sorts newest first', () => {
    resetTestDir();
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-27.jsonl'),
      `${JSON.stringify({
        traceId: 'trace-old',
        _persistedAt: '2026-05-27T09:00:00.000Z',
        metadata: {
          startedAt: '2026-05-27T08:59:00.000Z',
          completedAt: '2026-05-27T09:00:00.000Z',
        },
        rootSpan: {
          spanId: 'old-root-span',
          name: 'old-root',
          status: 'ok',
          startTime: '2026-05-27T08:59:00.000Z',
          endTime: '2026-05-27T09:00:00.000Z',
          events: [],
          artifacts: [],
          knowledgeRefs: [],
          children: [],
        },
      })}\n`
    );
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      `${JSON.stringify({
        traceId: 'trace-new',
        _persistedAt: '2026-05-28T10:00:00.000Z',
        metadata: {
          missionId: 'MSN-2',
          startedAt: '2026-05-28T09:59:00.000Z',
          completedAt: '2026-05-28T10:00:00.000Z',
        },
        rootSpan: {
          spanId: 'new-root-span',
          name: 'new-root',
          status: 'error',
          startTime: '2026-05-28T09:59:00.000Z',
          endTime: '2026-05-28T10:00:00.000Z',
          events: [{ name: 'one', timestamp: '2026-05-28T09:59:30.000Z' }],
          artifacts: [],
          knowledgeRefs: [],
          children: [],
        },
      })}\n`
    );

    const feed = collectTraceFeed({ dir: TEST_DIR, limit: 1 });
    expect(feed).toHaveLength(1);
    expect(feed[0].traceId).toBe('trace-new');
    expect(feed[0].missionId).toBe('MSN-2');
    expect(feed[0].status).toBe('error');
    expect(feed[0].spanCount).toBe(1);
  });

  it('does not read symlinked trace files', () => {
    resetTestDir();
    const target = path.join(TEST_DIR, 'target.jsonl');
    const link = path.join(TEST_DIR, 'traces-2026-05-29.jsonl');
    safeWriteFile(
      target,
      `${JSON.stringify({
        traceId: 'trace-linked',
        _persistedAt: '2026-05-29T10:00:00.000Z',
        rootSpan: {
          name: 'root',
          status: 'ok',
          startTime: '2026-05-29T09:59:00.000Z',
          events: [],
          artifacts: [],
          knowledgeRefs: [],
          children: [],
        },
      })}\n`
    );
    safeSymlinkSync(target, link);

    expect(collectTraceFeed({ dir: TEST_DIR })).toEqual([]);
    expect(collectTraceDetail('trace-linked', { dir: TEST_DIR })).toBeNull();
  });

  it('collects a detailed trace by trace id', () => {
    resetTestDir();
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      `${JSON.stringify({
        traceId: 'trace-detail',
        _persistedAt: '2026-05-28T10:00:00.000Z',
        metadata: {
          missionId: 'MSN-3',
          actuator: 'chronos',
          pipelineId: 'pipeline-3',
          startedAt: '2026-05-28T09:59:00.000Z',
          completedAt: '2026-05-28T10:00:00.000Z',
        },
        rootSpan: {
          spanId: 'root-span',
          name: 'detail-root',
          status: 'ok',
          startTime: '2026-05-28T09:59:00.000Z',
          endTime: '2026-05-28T10:00:00.000Z',
          attributes: { mode: 'inspect' },
          events: [{ name: 'root-event', timestamp: '2026-05-28T09:59:10.000Z' }],
          artifacts: [
            { type: 'file', path: '/tmp/detail.txt', timestamp: '2026-05-28T09:59:20.000Z' },
          ],
          knowledgeRefs: ['knowledge/public/example.md'],
          children: [
            {
              spanId: 'child-span',
              name: 'child',
              status: 'error',
              startTime: '2026-05-28T09:59:30.000Z',
              endTime: '2026-05-28T09:59:40.000Z',
              events: [{ name: 'child-event', timestamp: '2026-05-28T09:59:35.000Z' }],
              artifacts: [],
              knowledgeRefs: [],
              error: 'boom',
              children: [],
            },
          ],
        },
      })}\n`
    );

    const trace = collectTraceDetail('trace-detail', { dir: TEST_DIR });
    expect(trace?.traceId).toBe('trace-detail');
    expect(trace?.rootSpan.spanId).toBe('root-span');
    expect(trace?.rootSpan.children).toHaveLength(1);
    expect(trace?.rootSpan.children[0].error).toBe('boom');
    expect(trace?.rootSpan.events).toHaveLength(1);
    expect(trace?.rootSpan.artifacts).toHaveLength(1);
  });

  it('filters trace summaries and details by the viewer tenant allowlist', () => {
    resetTestDir();
    const record = (traceId: string, tenantSlug?: string) => ({
      traceId,
      _persistedAt: '2026-05-28T16:00:00.000Z',
      metadata: { tenantSlug, startedAt: '2026-05-28T15:59:00.000Z' },
      rootSpan: {
        spanId: `${traceId}-span`,
        name: traceId,
        status: 'ok',
        startTime: '2026-05-28T15:59:00.000Z',
        events: [],
        artifacts: [],
        knowledgeRefs: [],
        children: [],
      },
    });
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      [record('trace-a', 'tenant-a'), record('trace-b', 'tenant-b'), record('trace-legacy')]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join('')
    );

    const feed = collectTraceFeed({ dir: TEST_DIR, tenantSlugs: ['tenant-a'] });
    expect(feed.map((entry) => entry.traceId)).toEqual(['trace-a']);
    expect(collectTraceDetail('trace-b', { dir: TEST_DIR, tenantSlugs: ['tenant-a'] })).toBeNull();
    expect(
      collectTraceDetail('trace-a', { dir: TEST_DIR, tenantSlugs: ['tenant-a'] })?.tenantSlug
    ).toBe('tenant-a');
  });

  it('filters trace summaries and details by the viewer tier allowlist', () => {
    resetTestDir();
    const record = (traceId: string, tier?: string) => ({
      traceId,
      _persistedAt: '2026-05-28T16:00:00.000Z',
      metadata: { tier, startedAt: '2026-05-28T15:59:00.000Z' },
      rootSpan: {
        spanId: `${traceId}-span`,
        name: traceId,
        status: 'ok',
        startTime: '2026-05-28T15:59:00.000Z',
        events: [],
        artifacts: [],
        knowledgeRefs: [],
        children: [],
      },
    });
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      [
        record('trace-public', 'public'),
        record('trace-personal', 'personal'),
        record('trace-legacy'),
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join('')
    );

    const feed = collectTraceFeed({ dir: TEST_DIR, tierAccess: ['public', 'confidential'] });
    expect(feed.map((entry) => entry.traceId)).toEqual(['trace-public']);
    expect(
      collectTraceDetail('trace-personal', {
        dir: TEST_DIR,
        tierAccess: ['public', 'confidential'],
      })
    ).toBeNull();
    expect(
      collectTraceDetail('trace-public', { dir: TEST_DIR, tierAccess: ['public', 'confidential'] })
        ?.tier
    ).toBe('public');
  });

  it('filters traces by status, mission, actuator, and query', () => {
    resetTestDir();
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      [
        {
          traceId: 'trace-alpha',
          _persistedAt: '2026-05-28T10:00:00.000Z',
          metadata: {
            missionId: 'MSN-A',
            actuator: 'chronos',
            pipelineId: 'pipeline-a',
            startedAt: '2026-05-28T09:59:00.000Z',
            completedAt: '2026-05-28T10:00:00.000Z',
          },
          rootSpan: {
            spanId: 'alpha-root-span',
            name: 'alpha-root',
            status: 'ok',
            startTime: '2026-05-28T09:59:00.000Z',
            endTime: '2026-05-28T10:00:00.000Z',
            events: [],
            artifacts: [],
            knowledgeRefs: [],
            children: [],
          },
        },
        {
          traceId: 'trace-beta',
          _persistedAt: '2026-05-28T10:05:00.000Z',
          metadata: {
            missionId: 'MSN-B',
            actuator: 'other',
            pipelineId: 'pipeline-b',
            startedAt: '2026-05-28T10:04:00.000Z',
            completedAt: '2026-05-28T10:05:00.000Z',
          },
          rootSpan: {
            spanId: 'beta-root-span',
            name: 'beta-root',
            status: 'error',
            startTime: '2026-05-28T10:04:00.000Z',
            endTime: '2026-05-28T10:05:00.000Z',
            events: [],
            artifacts: [],
            knowledgeRefs: [],
            children: [],
          },
        },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('')
    );

    expect(collectTraceFeed({ dir: TEST_DIR, status: 'ok' })).toHaveLength(1);
    expect(collectTraceFeed({ dir: TEST_DIR, missionId: 'MSN-B' })).toHaveLength(1);
    expect(collectTraceFeed({ dir: TEST_DIR, actuator: 'chronos' })).toHaveLength(1);
    expect(collectTraceFeed({ dir: TEST_DIR, query: 'alpha-root' })).toHaveLength(1);
  });

  it('skips persisted traces that fail replay validation', () => {
    resetTestDir();
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      `${JSON.stringify({
        traceId: 'trace-invalid',
        metadata: { startedAt: '2026-05-28T10:00:00.000Z' },
        rootSpan: {
          spanId: '',
          name: 'invalid-root',
          status: 'ok',
          startTime: '2026-05-28T10:00:00.000Z',
          events: [],
          artifacts: [],
          knowledgeRefs: [],
          children: [],
        },
      })}\n`
    );

    expect(collectTraceFeed({ dir: TEST_DIR })).toEqual([]);
    expect(collectTraceDetail('trace-invalid', { dir: TEST_DIR })).toBeNull();
  });

  it('skips primitive and array JSONL records before projection', () => {
    resetTestDir();
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      '["not-a-trace"]\nnull\n{"traceId":"missing-root"}\n'
    );

    expect(collectTraceFeed({ dir: TEST_DIR })).toEqual([]);
  });

  it('can enforce the closed extension vocabulary for persisted feeds', () => {
    resetTestDir();
    const record = (traceId: string, name: string) => ({
      traceId,
      _persistedAt: '2026-05-28T10:00:00.000Z',
      rootSpan: {
        spanId: `${traceId}-span`,
        name,
        status: 'ok',
        startTime: '2026-05-28T09:59:00.000Z',
        events: [],
        artifacts: [],
        knowledgeRefs: [],
        children: [],
      },
    });
    safeWriteFile(
      path.join(TEST_DIR, 'traces-2026-05-28.jsonl'),
      `${JSON.stringify(record('trace-known', 'pipeline:known'))}\n${JSON.stringify(record('trace-unknown', 'attacker:exfiltrate'))}\n`
    );

    expect(
      collectTraceFeed({ dir: TEST_DIR, strictUnknownSpans: true }).map((trace) => trace.traceId)
    ).toEqual(['trace-known']);
    expect(
      collectTraceDetail('trace-unknown', { dir: TEST_DIR, strictUnknownSpans: true })
    ).toBeNull();
  });
});
