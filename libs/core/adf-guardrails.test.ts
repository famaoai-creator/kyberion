import { describe, expect, it } from 'vitest';

import { validatePipelineGuardrails } from './adf-guardrails.js';

describe('validatePipelineGuardrails', () => {
  it('allows a simple pipeline with a literal https hook URL', () => {
    const report = validatePipelineGuardrails({
      steps: [
        {
          op: 'demo:step',
          params: {},
          hooks: {
            before: [
              {
                type: 'http',
                url: 'https://github.com/health',
              },
            ],
          },
        },
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it('blocks a dangerous command hook', () => {
    const report = validatePipelineGuardrails({
      steps: [
        {
          op: 'demo:step',
          params: {},
          hooks: {
            before: [
              {
                type: 'command',
                cmd: 'rm -rf /',
              },
            ],
          },
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'command-denied')).toBe(true);
  });

  it('blocks step budgets that exceed max_steps', () => {
    const report = validatePipelineGuardrails(
      {
        options: {
          max_steps: 1,
        },
        steps: [
          { op: 'step:one', params: {} },
          { op: 'step:two', params: {} },
        ],
      },
      'example-pipeline'
    );

    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'step-budget-exceeded')).toBe(true);
  });

  it('walks parallel and loop control bodies when validating step budgets', () => {
    const report = validatePipelineGuardrails({
      options: {
        max_steps: 10,
      },
      steps: [
        {
          op: 'core:parallel_foreach',
          params: {
            items: [1, 2],
            do: [
              { op: 'step:one', params: {} },
              { op: 'step:two', params: {} },
            ],
          },
        },
        {
          op: 'core:while',
          params: {
            max_iterations: 3,
            pipeline: [{ op: 'step:three', params: {} }],
          },
        },
        {
          op: 'core:accumulate',
          params: {
            items: [1, 2],
            target_count: 1,
            do: [{ op: 'step:four', params: {} }],
          },
        },
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
  });
});

describe('semantic-op placement lint (LC-05)', () => {
  it('warns on llm_decide without a preceding distill op or explicit observation', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-demo',
      steps: [
        { op: 'browser:navigate', params: { url: 'https://example.com' } },
        { op: 'browser:llm_decide', params: { goal: 'pick something' } },
      ],
    } as any);
    const codes = report.findings.map((finding) => finding.code);
    expect(report.ok).toBe(true); // warnings only
    expect(codes).toContain('llm-decide-without-distill');
    expect(codes).toContain('llm-decide-without-fallback');
  });

  it('stays quiet for the rubric-shaped distill -> select pattern', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-clean',
      steps: [
        { op: 'browser:distill_dom', params: {} },
        {
          op: 'browser:llm_decide',
          params: { goal: 'pick the submit selector', options: ['#a', '#b'] },
        },
      ],
    } as any);
    expect(report.findings).toHaveLength(0);
  });

  it('accepts explicit observation or on_degraded declarations', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-declared',
      steps: [
        {
          op: 'browser:llm_decide',
          params: { goal: 'summarize', observation: 'pre-distilled text', on_degraded: 'fail' },
        },
      ],
    } as any);
    expect(report.findings).toHaveLength(0);
  });
});

describe('logic-layering lint (LE-04/LE-05)', () => {
  it('warns on an oversized core:transform script without flipping ok', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-transform',
      steps: [
        {
          op: 'core:transform',
          params: { script: 'x'.repeat(401), export_as: 'out' },
        },
      ],
    } as any);
    expect(report.ok).toBe(true);
    const finding = report.findings.find((f) => f.code === 'transform-script-oversized');
    expect(finding?.severity).toBe('warn');
  });

  it('accepts small core:transform glue scripts silently', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-transform-small',
      steps: [{ op: 'core:transform', params: { script: 'return ctx.value;' } }],
    } as any);
    expect(report.findings).toHaveLength(0);
  });

  it('walks media:pipeline embedded steps for budgets and lints', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-media-embedded',
      options: { max_steps: 2 },
      steps: [
        {
          op: 'media:pipeline',
          params: {
            steps: [
              { op: 'media:json_read', params: {} },
              { op: 'core:transform', params: { script: 'y'.repeat(401) } },
            ],
          },
        },
      ],
    } as any);
    expect(report.findings.some((f) => f.code === 'step-budget-exceeded')).toBe(true);
    expect(report.findings.some((f) => f.code === 'transform-script-oversized')).toBe(true);
  });
});
