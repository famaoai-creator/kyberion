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
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
  });
});
