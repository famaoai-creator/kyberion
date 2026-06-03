import { describe, expect, it } from 'vitest';
import { TraceContext } from '@agent/core';
import { normalizePipelineOp, runSteps, formatPipelineFailure, validateFlow } from './run_pipeline.js';

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

  it('resolves shell env values from context before execution', async () => {
    const result = await runSteps([
      {
        op: 'shell',
        params: {
          cmd: 'printf %s "$FOO"',
          env: {
            FOO: '{{name}}',
          },
          export_as: 'shell_env_result',
        },
      },
    ], { name: 'world' });

    expect(result.status).toBe('succeeded');
    expect(result.context.shell_env_result).toBe('world');
  });

  it('formats classified pipeline failures with remediation', () => {
    const failure = formatPipelineFailure(
      "[POLICY_VIOLATION] Persona 'unknown' with authority role 'forks' is NOT authorized to write to '/x'.",
    );

    expect(failure.classification.category).toBe('permission_denied');
    expect(failure.classification.ruleId).toBe('kyberion.path-scope');
    expect(failure.summary).toContain('[permission_denied]');
    expect(failure.summary).toContain('Path scope policy denied write');
  });

  it('exports context via legacy export_as (backward compatibility)', async () => {
    const result = await runSteps([
      {
        op: 'shell',
        type: 'capture',
        params: { cmd: 'printf legacy', export_as: 'legacy_key' },
      },
    ]);
    expect(result.status).toBe('succeeded');
    expect(result.context.legacy_key).toBe('legacy');
  });
});

describe('validateFlow', () => {
  it('returns empty errors for a valid chain', () => {
    const errors = validateFlow([
      { op: 'media:pptx_extract', role: 'source', produces: { channel: 'pptx_design', type: 'PptxDesign' }, params: {} },
      { op: 'media:theme_from_pptx', role: 'transform', consumes: 'pptx_design', produces: 'active_theme', params: {} },
      { op: 'media:save_brand', role: 'sink', consumes: ['active_theme'], params: {} },
    ]);
    expect(errors).toEqual([]);
  });

  it('reports missing channel when consumes has no upstream producer', () => {
    const errors = validateFlow([
      { op: 'media:save_brand', role: 'sink', consumes: 'active_theme', params: {} },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].stepId).toBe('media:save_brand');
    expect(errors[0].missing).toEqual(['active_theme']);
  });

  it('reports multiple missing channels per step', () => {
    const errors = validateFlow([
      { op: 'media:save_brand', role: 'sink', consumes: ['active_theme', 'layout_geometry'], params: {} },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].missing).toContain('active_theme');
    expect(errors[0].missing).toContain('layout_geometry');
  });

  it('uses step.id as stepId when present', () => {
    const errors = validateFlow([
      { id: 'save_brand_step', op: 'media:save_brand', role: 'sink', consumes: 'missing_channel', params: {} },
    ]);
    expect(errors[0].stepId).toBe('save_brand_step');
  });

  it('satisfies consumes from initial context', () => {
    const errors = validateFlow(
      [{ op: 'media:save_brand', role: 'sink', consumes: 'active_theme', params: {} }],
      { active_theme: { colors: {} } },
    );
    expect(errors).toEqual([]);
  });

  it('registers legacy export_as as available channel', () => {
    const errors = validateFlow([
      { op: 'shell', params: { export_as: 'shell_out' } },
      { op: 'media:save_brand', role: 'sink', consumes: 'shell_out', params: {} },
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts string shorthand for produces', () => {
    const errors = validateFlow([
      { op: 'browser:snapshot', role: 'source', produces: 'web_snapshot', params: {} },
      { op: 'reasoning:synthesize', role: 'transform', consumes: 'web_snapshot', produces: 'active_theme', params: {} },
    ]);
    expect(errors).toEqual([]);
  });
});

describe('Typed Flow role resolution', () => {
  it('treats role:source step output as accessible via produces channel', async () => {
    const result = await runSteps([
      {
        id: 'capture_step',
        op: 'shell',
        role: 'source',
        produces: 'shell_data',
        params: { cmd: 'printf typed-flow', export_as: 'shell_data' },
      },
      {
        id: 'log_step',
        op: 'log',
        role: 'sink',
        params: { template: 'got: {{shell_data}}' },
      },
    ]);
    expect(result.status).toBe('succeeded');
    expect(result.context.shell_data).toBe('typed-flow');
  });

  it('treats role:transform step output as accessible via produces channel', async () => {
    const result = await runSteps([
      {
        op: 'shell',
        role: 'source',
        produces: 'raw',
        params: { cmd: 'printf hello', export_as: 'raw' },
      },
      {
        op: 'shell',
        role: 'transform',
        consumes: 'raw',
        produces: 'processed',
        params: { cmd: 'printf processed', export_as: 'processed' },
      },
      {
        op: 'log',
        role: 'sink',
        params: { template: '{{processed}}' },
      },
    ]);
    expect(result.status).toBe('succeeded');
    expect(result.context.processed).toBe('processed');
  });

  it('records pipeline step status, duration, and error classification in trace events', async () => {
    const trace = new TraceContext('pipeline:trace-contract', { pipelineId: 'trace-contract' });

    const result = await runSteps([
      {
        id: 'first-step',
        op: 'log',
        params: {
          template: 'hello',
        },
      },
      {
        id: 'failing-step',
        op: 'shell',
        params: {
          cmd: 'exit 7',
        },
      },
    ], {}, { trace });

    const finalized = trace.finalize();
    const firstSpan = finalized.rootSpan.children[0];
    const failingSpan = finalized.rootSpan.children[1];
    const completed = firstSpan.events.find((event) => event.name === 'step.completed');
    const failed = failingSpan.events.find((event) => event.name === 'step.failed');

    expect(result.status).toBe('failed');
    expect(completed?.attributes).toMatchObject({
      step_id: 'first-step',
      op: 'system:log',
      status: 'success',
    });
    expect(typeof completed?.attributes?.duration_ms).toBe('number');
    expect(failed?.attributes).toMatchObject({
      step_id: 'failing-step',
      op: 'system:shell',
      status: 'failed',
      error_category: expect.any(String),
      error_rule_id: expect.any(String),
    });
    expect(typeof failed?.attributes?.duration_ms).toBe('number');
  });
});
