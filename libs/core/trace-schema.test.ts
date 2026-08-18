import { describe, expect, it } from 'vitest';
import {
  getTraceSpanDefinition,
  redactTraceAttributes,
  resolveTraceSpanKind,
  sanitizeTraceForPersistence,
  traceAttributesForMetrics,
  validateTraceReplay,
  validateTraceAttributes,
  validateTraceParent,
} from './trace-schema.js';

describe('PI-06 trace schema', () => {
  it('resolves governed span kinds and parent constraints', () => {
    expect(resolveTraceSpanKind('mission_task_dispatch')).toBe('mission');
    expect(getTraceSpanDefinition('compaction:summary')).toMatchObject({ name: 'compaction' });
    expect(validateTraceParent('step', 'task')).toEqual([]);
    expect(validateTraceParent('tool', 'mission')).toEqual([]);
    expect(validateTraceParent('tool', 'judge')[0]?.message).toContain('parent must be one of');
  });

  it('validates types and redacts sensitive fields', () => {
    expect(
      validateTraceAttributes('mission', { mission_id: 42, tenant_slug: 'tenant-a' })
    ).toContainEqual({ path: 'mission.start.mission_id', message: 'expected string' });
    expect(redactTraceAttributes('mission', { tenant_slug: 'tenant-a', mission_id: 'M1' })).toEqual(
      {
        tenant_slug: '[REDACTED]',
        mission_id: 'M1',
      }
    );
  });

  it('rejects undeclared and out-of-vocabulary exact attributes', () => {
    expect(validateTraceAttributes('compaction', { reason: 'retry' })).toMatchObject([
      { path: 'compaction.start.reason', message: 'expected one of manual, threshold, overflow' },
    ]);
    expect(
      validateTraceAttributes('mission', { mission_id: 'M1', unexpected: true })
    ).toMatchObject([
      {
        path: 'mission.start.unexpected',
        message: 'attribute is not declared by the trace schema',
      },
    ]);
  });

  it('excludes sensitive and high-cardinality attributes from metrics', () => {
    expect(
      traceAttributesForMetrics('gate', {
        gate_name: 'approval',
        policy_ref: 'policy-a',
        reason: 'path detail',
      })
    ).toEqual({ gate_name: 'approval', policy_ref: 'policy-a' });
  });

  it('sanitizes a trace copy without mutating the source', () => {
    const trace = {
      traceId: 'trace-1',
      metadata: { startedAt: '2026-01-01T00:00:00.000Z' },
      rootSpan: {
        spanId: 'span-1',
        name: 'mission',
        startTime: '2026-01-01T00:00:00.000Z',
        status: 'ok' as const,
        attributes: { tenant_slug: 'secret-tenant', mission_id: 'M1' },
        events: [],
        artifacts: [],
        knowledgeRefs: [],
        children: [],
      },
    };
    const sanitized = sanitizeTraceForPersistence(trace);
    expect(sanitized.rootSpan.attributes?.tenant_slug).toBe('[REDACTED]');
    expect(trace.rootSpan.attributes?.tenant_slug).toBe('secret-tenant');
  });

  it('provides exact attribute types and validates replay structure', () => {
    const missionStart = {
      mission_id: 'M1',
      tenant_slug: 'tenant-a',
    } satisfies import('./trace-schema.js').ExactTelemetryAttributes<'mission'>;
    expect(missionStart.mission_id).toBe('M1');

    expect(
      validateTraceReplay({
        traceId: 'trace-1',
        rootSpan: {
          name: 'mission',
          status: 'ok',
          attributes: { mission_id: 42 },
          events: [],
          children: [],
        },
      })
    ).toContainEqual({ path: 'mission.start.mission_id', message: 'expected string' });
    expect(
      validateTraceReplay({
        traceId: 'trace-2',
        rootSpan: {
          name: 'workflow.custom',
          status: 'ok',
          events: [],
          children: [{ status: 'ok', events: [], children: [] }],
        },
      })
    ).toContainEqual({
      path: 'trace.rootSpan.children[0].name',
      message: 'span name must be a non-empty string',
    });
  });
});
