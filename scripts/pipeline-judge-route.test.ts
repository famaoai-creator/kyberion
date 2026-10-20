import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSteps } from './pipeline-execution-part-execution.js';

const calls = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  delegate: vi.fn(),
  backend: vi.fn(),
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  installReasoningBackends: calls.bootstrap,
}));
vi.mock('@agent/core/reasoning/reasoning-backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/reasoning/reasoning-backend')>();
  return {
    ...actual,
    getReasoningBackend: () => {
      calls.backend();
      return {
        ...actual.stubReasoningBackend,
        name: 'judge-fixture-backend',
        delegateTask: calls.delegate,
      };
    },
  };
});

async function runJudge(params: Record<string, unknown>) {
  return runSteps(
    [
      {
        id: 'judge',
        op: 'core:judge_route',
        params: {
          export_as: 'selected_route',
          routes: [{ when: { label: 'approve' }, next: 'COMPLETE' }],
          ...params,
        },
        on_error: { strategy: 'abort' },
      },
      { id: 'after', op: 'system:log', params: { message: 'must not execute' } },
    ],
    {},
    { quiet: true }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.delegate.mockReset().mockResolvedValue('{"label":"approve"}');
});
afterEach(() => vi.restoreAllMocks());

describe('judge route verdict contracts', () => {
  it.each([undefined, null, [], 1, { label: '' }, { approve: true }])(
    'rejects an invalid default fixture before routing or provider calls: %j',
    async (verdict) => {
      const result = await runJudge({ fixture: true, verdict });
      expect(result.status).toBe('failed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.error).toContain('JUDGE_ROUTE_VERDICT_INVALID');
      expect(result.context).not.toHaveProperty('selected_route');
      expect(calls.bootstrap).not.toHaveBeenCalled();
      expect(calls.delegate).not.toHaveBeenCalled();
    }
  );

  it('preserves a valid default fixture and extra verdict fields', async () => {
    const verdict = { label: 'approve', reason: 'ready', decision: { status: 'ready' } };
    const result = await runJudge({ fixture: true, verdict });
    expect(result.status).toBe('succeeded');
    expect(result.context.judge_verdict).toEqual(verdict);
    expect(result.context.selected_route).toMatchObject({ next: 'COMPLETE', matched: true });
    expect(calls.delegate).not.toHaveBeenCalled();
  });

  it.each(['schema_ref', 'judge'])('honors an explicit registered schema via %s', async (key) => {
    const result = await runJudge({
      fixture: true,
      ...(key === 'judge'
        ? { judge: { schema_ref: 'planning_review_verdict' } }
        : { schema_ref: 'planning_review_verdict' }),
      verdict: { approve: true, gaps: [] },
      routes: [{ when: { field: 'approve', eq: true }, next: 'COMPLETE' }],
    });
    expect(result.status).toBe('succeeded');
    expect(result.context.selected_route).toMatchObject({ next: 'COMPLETE', matched: true });
  });

  it('does not replace an explicit verdict schema with the default label contract', async () => {
    const result = await runJudge({
      fixture: true,
      schema_ref: 'planning_review_verdict',
      verdict: { label: 'approve' },
    });
    expect(result.status).toBe('failed');
    expect(result.results[0]?.error).toContain('JUDGE_ROUTE_VERDICT_INVALID');
  });

  it.each(['', '   ', null, 42, {}])(
    'rejects an explicitly invalid schema ref: %j',
    async (schema_ref) => {
      const result = await runJudge({ schema_ref });
      expect(result.status).toBe('failed');
      expect(result.results[0]?.error).toContain('JUDGE_ROUTE_SCHEMA_INVALID');
      expect(calls.bootstrap).not.toHaveBeenCalled();
      expect(calls.delegate).not.toHaveBeenCalled();
    }
  );

  it.each(['unknown_verdict', '../secret.json', 'nonexistent-verdict.schema.json'])(
    'rejects unknown or unsafe schema %s before provider startup',
    async (schema_ref) => {
      const result = await runJudge({ schema_ref });
      expect(result.status).toBe('failed');
      expect(result.results[0]?.error).toMatch(/REPORT_SCHEMA_(INVALID|NOT_FOUND)/);
      expect(calls.bootstrap).not.toHaveBeenCalled();
      expect(calls.backend).not.toHaveBeenCalled();
      expect(calls.delegate).not.toHaveBeenCalled();
    }
  );

  it('validates nested product JSON-schema fields before a fixture may route', async () => {
    const params = {
      fixture: true,
      schema_ref: 'review-gate-result.schema.json',
      routes: [{ when: { field: 'overall_verdict', eq: 'ready' }, next: 'COMPLETE' }],
    };
    const verdict = {
      review_mode: 'lean',
      overall_verdict: 'ready',
      gate_results: [{ gate_id: 'review', verdict: 'ready' }],
    };
    const valid = await runJudge({ ...params, verdict });
    expect(valid.status).toBe('succeeded');
    const invalid = await runJudge({
      ...params,
      verdict: { ...verdict, gate_results: [{ gate_id: 'review', verdict: 'invented' }] },
    });
    expect(invalid.status).toBe('failed');
    expect(invalid.results[0]?.error).toContain('JUDGE_ROUTE_VERDICT_INVALID');
    expect(calls.delegate).not.toHaveBeenCalled();
  });

  it('retries schema-invalid generated verdicts before selecting an explicit route', async () => {
    calls.delegate
      .mockResolvedValueOnce('{"label":"approve"}')
      .mockResolvedValueOnce('{"approve":true,"gaps":[]}');
    const result = await runJudge({
      schema_ref: 'planning_review_verdict',
      routes: [{ when: { field: 'approve', eq: true }, next: 'COMPLETE' }],
    });
    expect(result.status).toBe('succeeded');
    expect(calls.delegate).toHaveBeenCalledTimes(2);
    expect(calls.delegate.mock.calls[0]?.[0]).toContain('"approve"');
    expect(calls.delegate.mock.calls[1]?.[0]).toContain('JUDGE_ROUTE_VERDICT_INVALID');
    expect(result.context.judge_verdict).toEqual({ approve: true, gaps: [] });
  });

  it('exhausts the existing retry bound without routing malformed generated verdicts', async () => {
    calls.delegate.mockResolvedValue('{"label":"approve"}');
    const result = await runJudge({ schema_ref: 'planning_review_verdict' });
    expect(result.status).toBe('failed');
    expect(calls.delegate).toHaveBeenCalledTimes(3);
    expect(result.results).toHaveLength(1);
    expect(result.context).not.toHaveProperty('selected_route');
  });
});
