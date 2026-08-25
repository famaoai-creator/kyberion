import { describe, expect, it } from 'vitest';

import { forbiddenGitCoexecutionMutation, validatePipelineGuardrails } from './adf-guardrails.js';

describe('validatePipelineGuardrails', () => {
  it('blocks broad git mutations in ADF shell steps while allowing explicit-path push', () => {
    const report = validatePipelineGuardrails({
      steps: [
        { op: 'system:shell', params: { cmd: 'git reset --hard HEAD' } },
        { op: 'system:shell', params: { cmd: 'git add . && git commit -m x' } },
      ],
    });
    expect(report.ok).toBe(false);
    expect(
      report.findings.filter((finding) => finding.code === 'git-coexecution-mutation-forbidden')
    ).toHaveLength(2);
    expect(forbiddenGitCoexecutionMutation('git push origin feature')).toBeUndefined();
    expect(forbiddenGitCoexecutionMutation('git add src/file.ts')).toBeUndefined();
    expect(forbiddenGitCoexecutionMutation('git push --force origin feature')).toBe(
      'git push --force'
    );
  });

  it('blocks typed command plus args wrappers for node, pnpm, and npx', () => {
    const report = validatePipelineGuardrails({
      steps: [
        { op: 'system:exec', params: { command: 'node', args: ['dist/scripts/task.js'] } },
        {
          op: 'system:exec',
          params: { command: 'pnpm', args: ['exec', 'tsx', 'scripts/task.ts'] },
        },
        { op: 'system:exec', params: { command: 'npx', args: ['tsx', 'scripts/task.ts'] } },
      ],
    });
    expect(report.ok).toBe(false);
    expect(
      report.findings.filter((finding) => finding.code === 'script-wrapper-forbidden')
    ).toHaveLength(3);
  });

  it('preserves raw command-string wrapper rejection', () => {
    const report = validatePipelineGuardrails({
      steps: [
        { op: 'system:exec', params: { command: 'node dist/scripts/task.js' } },
        { op: 'system:shell', params: { cmd: 'pnpm exec tsx scripts/task.ts' } },
        { op: 'system:shell', params: { cmd: 'npx tsx scripts/task.ts' } },
      ],
    });
    expect(report.ok).toBe(false);
    expect(
      report.findings.filter((finding) => finding.code === 'script-wrapper-forbidden')
    ).toHaveLength(3);
  });

  it('warns when a dynamic include cannot be expanded during preflight', () => {
    const report = validatePipelineGuardrails({
      steps: [{ op: 'core:include', params: { fragment: '{{fragment_ref}}' } }],
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'include-ref-dynamic', severity: 'warn' })
    );
  });

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

  it('caps team_lead worker concurrency at three', () => {
    const report = validatePipelineGuardrails({
      steps: [
        {
          op: 'core:team_lead',
          params: { max_concurrency: 4, do: [{ op: 'step:worker', params: {} }] },
        },
      ],
    });
    expect(report.ok).toBe(false);
    expect(
      report.findings.some((finding) => finding.code === 'team-lead-concurrency-exceeded')
    ).toBe(true);
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
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);
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
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);
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
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);
    expect(report.findings).toHaveLength(0);
  });
});

describe('TAKT judge_route guardrails', () => {
  it('rejects an unknown route target and fails closed on a back-edge', () => {
    const report = validatePipelineGuardrails({
      steps: [
        {
          id: 'judge',
          op: 'core:judge_route',
          params: { routes: [{ when: { label: 'x' }, next: 'missing' }] },
        },
        { id: 'done', op: 'system:log', params: {} },
      ],
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);

    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'judge-route-unknown-target')).toBe(
      true
    );
    expect(report.findings.some((finding) => finding.code === 'loop-max-iterations-omitted')).toBe(
      true
    );
  });

  it('rejects a route target that is earlier than the judge step', () => {
    const report = validatePipelineGuardrails({
      steps: [
        { id: 'start', op: 'system:log', params: {} },
        {
          id: 'judge',
          op: 'core:judge_route',
          params: {
            max_route_hops: 4,
            routes: [{ when: { label: 'retry' }, next: 'start' }],
          },
        },
      ],
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);

    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'judge-route-back-edge')).toBe(true);
    expect(
      report.findings.find((finding) => finding.code === 'judge-route-back-edge')?.severity
    ).toBe('error');
  });

  it('accepts terminal routes and explicit hop limits', () => {
    const report = validatePipelineGuardrails({
      steps: [
        {
          id: 'judge',
          op: 'core:judge_route',
          params: {
            max_route_hops: 6,
            routes: [
              { when: { label: 'approve' }, next: 'COMPLETE' },
              { when: { label: 'reject' }, next: 'ABORT' },
            ],
          },
        },
      ],
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);

    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
  });
});

describe('logic-layering lint (LE-04/LE-05)', () => {
  it('blocks an oversized core:transform script', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-transform',
      steps: [
        {
          op: 'core:transform',
          params: { script: 'x'.repeat(401), export_as: 'out' },
        },
      ],
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.code === 'transform-script-oversized');
    expect(finding?.severity).toBe('error');
  });

  it('accepts small core:transform glue scripts silently', () => {
    const report = validatePipelineGuardrails({
      id: 'lint-transform-small',
      steps: [{ op: 'core:transform', params: { script: 'return ctx.value;' } }],
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);
    expect(report.findings).toHaveLength(0);
  });

  it('blocks shell wrappers around scripts and built actuators', () => {
    const report = validatePipelineGuardrails({
      steps: [
        { op: 'system:exec', params: { command: 'node dist/scripts/run_pipeline.js' } },
        { op: 'system:shell', params: { cmd: 'npx tsx scripts/check.ts' } },
        { op: 'system:shell', params: { cmd: 'node dist/libs/actuators/browser/index.js' } },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.findings.filter((f) => f.code === 'script-wrapper-forbidden')).toHaveLength(3);
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
    } as unknown as Parameters<typeof validatePipelineGuardrails>[0]);
    expect(report.findings.some((f) => f.code === 'step-budget-exceeded')).toBe(true);
    expect(report.findings.some((f) => f.code === 'transform-script-oversized')).toBe(true);
  });
});
