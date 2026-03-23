import { describe, expect, it } from 'vitest';
import { normalizePipelineOp, runSteps } from './run_pipeline.js';

describe('run_pipeline compatibility', () => {
  it('normalizes short-form system ops to namespaced ops', () => {
    expect(normalizePipelineOp('shell')).toBe('system:shell');
    expect(normalizePipelineOp('log')).toBe('system:log');
    expect(normalizePipelineOp('if')).toBe('core:if');
    expect(normalizePipelineOp('system:shell')).toBe('system:shell');
  });

  it('accepts short-form log ops with template params', async () => {
    const result = await runSteps([
      {
        op: 'log',
        params: {
          template: 'hello {{name}}',
        },
      },
    ], { name: 'world' });

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([
      { op: 'system:log', status: 'success' },
    ]);
  });

  it('accepts short-form shell ops and exports context', async () => {
    const result = await runSteps([
      {
        op: 'shell',
        params: {
          cmd: 'printf test-output',
          export_as: 'shell_result',
        },
      },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.context.shell_result).toBe('test-output');
    expect(result.results).toEqual([
      { op: 'system:shell', status: 'success' },
    ]);
  });
});
