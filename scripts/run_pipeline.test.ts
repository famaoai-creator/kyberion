import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TraceContext } from '@agent/core';
import { logger } from '@agent/core';
import { pathResolver } from '@agent/core/path-resolver';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';

const {
  normalizePipelineOp,
  runSteps,
  runValidatedSteps,
  recordFallbackOutcome,
  finalizePipelineTrace,
  formatPipelineFailure,
  validateFlow,
  normalizeReasoningPolicy,
  buildReasoningPolicyNote,
  isReasoningBudgetExceeded,
} = await import(new URL('./run_pipeline.js', import.meta.url).href);

describe('run_pipeline compatibility', () => {
  it('persists a recovered fallback as one successful causal trace', () => {
    const trace = new TraceContext('pipeline:fallback-recovery', {
      pipelineId: 'fallback-recovery',
    });
    trace.startSpan('primary');
    trace.endSpan('error', 'permission denied');
    const failure = formatPipelineFailure('EACCES: permission denied');

    trace.addEvent('pipeline.fallback_started', {
      fallback_pipeline: 'pipelines/fallback.json',
      primary_error_category: failure.classification.category,
      primary_error_rule_id: failure.classification.ruleId,
    });
    const recovered = recordFallbackOutcome(trace, 'pipelines/fallback.json', failure, {
      status: 0,
    });
    const persisted = finalizePipelineTrace(trace, recovered, {
      dir: pathResolver.shared('tmp/run-pipeline-fallback-trace-test'),
    });

    expect(recovered).toBe(true);
    expect(persisted.trace.rootSpan.status).toBe('ok');
    expect(persisted.trace.rootSpan.children[0]).toMatchObject({
      name: 'primary',
      status: 'error',
      error: 'permission denied',
    });
    expect(persisted.trace.rootSpan.events.map((event) => event.name)).toEqual([
      'pipeline.fallback_started',
      'pipeline.fallback_succeeded',
    ]);
    expect(persisted.trace.rootSpan.events[1].attributes).toMatchObject({
      fallback_pipeline: 'pipelines/fallback.json',
      primary_error_category: failure.classification.category,
      fallback_exit_status: 0,
    });
  });

  it('uses the same one-based step number for start and completion progress', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await runSteps([{ op: 'log', params: { message: 'progress test' } }]);

    const progressLines = infoSpy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('[step '));
    expect(progressLines).toEqual([
      '[step 1/1] log …',
      expect.stringMatching(/^\[step 1\/1\] system:log success in \d+s$/),
    ]);
    infoSpy.mockRestore();
  });

  it('normalizes short-form system ops to namespaced ops', () => {
    expect(normalizePipelineOp('shell')).toBe('system:shell');
    expect(normalizePipelineOp('log')).toBe('system:log');
    expect(normalizePipelineOp('if')).toBe('core:if');
    expect(normalizePipelineOp('while')).toBe('core:while');
    expect(normalizePipelineOp('parallel_foreach')).toBe('core:parallel_foreach');
    expect(normalizePipelineOp('accumulate')).toBe('core:accumulate');
    expect(normalizePipelineOp('system:shell')).toBe('system:shell');
  });

  it('accepts short-form log ops with template params', async () => {
    const result = await runSteps(
      [
        {
          op: 'log',
          params: {
            template: 'hello {{name}}',
          },
        },
      ],
      { name: 'world' }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([{ op: 'system:log', status: 'success' }]);
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
    expect(result.results).toEqual([{ op: 'system:shell', status: 'success' }]);
  });

  it('executes direct commands without shell expansion', async () => {
    const result = await runSteps([
      {
        op: 'system:exec',
        params: {
          command: 'node',
          args: ['-e', 'process.stdout.write("exec-output")'],
          export_as: 'exec_result',
        },
      },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.context.exec_result).toMatchObject({
      stdout: 'exec-output',
      stderr: '',
      status: 0,
    });
    expect(result.results).toEqual([{ op: 'system:exec', status: 'success' }]);
  });

  it('parses JSON shell output into structured context when possible', async () => {
    const result = await runSteps([
      {
        op: 'shell',
        params: {
          cmd: 'printf %s \'{"summary_line":"[UNHANDLED-INTENT] unreconciled=3 top=hello (2)"}\'',
          export_as: 'reconcile_result',
        },
      },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.context.reconcile_result).toEqual({
      summary_line: '[UNHANDLED-INTENT] unreconciled=3 top=hello (2)',
    });
  });

  it('resolves shell env values from context before execution', async () => {
    const result = await runSteps(
      [
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
      ],
      { name: 'world' }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.shell_env_result).toBe('world');
  });

  it('formats classified pipeline failures with remediation', () => {
    const failure = formatPipelineFailure(
      "[POLICY_VIOLATION] Persona 'unknown' with authority role 'forks' is NOT authorized to write to '/x'."
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

  it('blocks steps whose manifest capability is unavailable before dispatch (AC-01)', async () => {
    // blockchain:verify_anchor is declared with implemented:false, so the
    // capability gate must stop the step pre-execution with a teachable error.
    const result = await runSteps([
      {
        op: 'blockchain:verify_anchor',
        params: {},
      },
    ]);

    expect(result.status).toBe('failed');
    const failed = result.results.find(
      (entry: { status: string; error?: string }) => entry.status === 'failed'
    );
    expect(failed?.error).toContain('capability blockchain:verify_anchor unavailable');
    expect(failed?.error).toContain('not_implemented');
  }, 30000);

  it('runs storage janitor through the core op in dry-run mode', async () => {
    const result = await runSteps([
      {
        op: 'core:run_janitor',
        produces: 'janitor_report',
        params: {
          dry_run: true,
          export_as: 'janitor_report',
        },
      },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([{ op: 'core:run_janitor', status: 'success' }]);
    expect(result.context.janitor_report).toMatchObject({
      dryRun: true,
      expiredTmp: expect.any(Number),
      deletedTmp: 0,
      errors: expect.any(Array),
    });
  }, 30000);

  it('marks a false core:if branch as skipped when no else branch exists', async () => {
    const result = await runSteps(
      [
        {
          op: 'core:if',
          params: {
            condition: { from: 'flag', operator: 'eq', value: true },
            then: [{ op: 'system:log', params: { message: 'should not run' } }],
          },
        },
      ],
      { flag: false }
    );

    expect(result.status).toBe('succeeded');
    expect(result.results).toEqual([{ op: 'core:if', status: 'skipped' }]);
  });

  it('enforces options.max_steps when the pipeline sets it explicitly (AR-01)', async () => {
    const result = await runSteps(
      [
        { op: 'system:log', params: { message: 'one' } },
        { op: 'system:log', params: { message: 'two' } },
      ],
      { __pipeline_options: { max_steps: 1 } }
    );

    expect(result.status).toBe('failed');
    expect(result.results.at(-1)?.error).toContain('[SAFETY_LIMIT]');
    expect(result.results.filter((r) => r.status === 'success')).toHaveLength(1);
  });

  it('leaves pipelines without explicit budgets unbounded', async () => {
    const result = await runSteps([
      { op: 'system:log', params: { message: 'one' } },
      { op: 'system:log', params: { message: 'two' } },
    ]);

    expect(result.status).toBe('succeeded');
  });

  it('recovers a failing step via on_error: skip (AR-01 canonical semantics)', async () => {
    const result = await runSteps([
      { op: 'system:exec', params: {}, on_error: { strategy: 'skip' } } as any,
      { op: 'system:log', params: { message: 'still runs' } },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.results[0]).toMatchObject({ status: 'recovered' });
    expect(result.results.at(-1)).toMatchObject({ status: 'success' });
  });

  it('runs on_error fallback steps and flattens their results', async () => {
    const result = await runSteps([
      {
        op: 'system:exec',
        params: {},
        on_error: {
          strategy: 'fallback',
          fallback: [{ op: 'system:log', params: { message: 'salvage' } }],
        },
      } as any,
    ]);

    expect(result.status).toBe('succeeded');
    const statuses = result.results.map((r) => r.status);
    expect(statuses).toContain('success'); // fallback step, flattened
    expect(statuses).toContain('recovered'); // the failed-then-recovered step
    expect(result.context._error).toMatchObject({ step_op: 'system:exec' });
  });

  it('rejects system ops that fail input contract validation before dispatch', async () => {
    const result = await runSteps([
      {
        op: 'system:open_url',
        params: {},
      },
    ]);

    expect(result.status).toBe('failed');
    const failed = result.results.find(
      (entry: { status: string; error?: string }) => entry.status === 'failed'
    );
    expect(failed?.error).toContain('[INVALID_OP_INPUT]');
    expect(failed?.error).toContain('system:open_url');
    expect(failed?.error).toContain('url');
  });

  it('runs parallel_foreach with bounded concurrency and collects per-item outputs', async () => {
    const startedAt = Date.now();
    const result = await runSteps([
      {
        op: 'core:parallel_foreach',
        params: {
          items: [1, 2],
          as: 'item',
          concurrency: 2,
          export_as: 'parallel_outputs',
          do: [
            {
              op: 'core:wait',
              params: {
                duration_ms: 120,
              },
            },
            {
              op: 'core:transform',
              params: {
                input: '{{item}}',
                script: 'return { doubled: Number(input) * 2 };',
                export_as: 'mapped',
              },
            },
          ],
        },
      },
    ]);
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe('succeeded');
    expect(elapsed).toBeLessThan(220);
    expect(result.context.parallel_outputs).toHaveLength(2);
    expect(result.context.parallel_outputs[0].context.mapped.doubled).toBe(2);
    expect(result.context.parallel_outputs[1].context.mapped.doubled).toBe(4);
  });

  it('runs accumulate until the unique target count is reached', async () => {
    const result = await runSteps([
      {
        op: 'core:accumulate',
        params: {
          items: [1, 1, 2, 3],
          as: 'item',
          target_count: 2,
          dry_streak_limit: 2,
          export_as: 'accumulated',
          collect_as: 'seen',
          do: [
            {
              op: 'core:transform',
              params: {
                input: '{{item}}',
                script: 'return { seen: Number(input) };',
                export_as: 'seen',
              },
            },
          ],
        },
      },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.context.accumulated.collected).toHaveLength(2);
    expect(result.context.accumulated.collected.map((entry: any) => entry.value.seen)).toEqual([
      1, 2,
    ]);
    expect(result.context.accumulated.iterations).toBe(3);
  });

  it('runs while loops until the condition is no longer true', async () => {
    const result = await runSteps(
      [
        {
          op: 'core:while',
          params: {
            condition: { from: 'loop.count', operator: 'lt', value: 3 },
            max_iterations: 5,
            export_as: 'loop_result',
            pipeline: [
              {
                op: 'core:transform',
                params: {
                  input: '{{loop.count}}',
                  script: 'return { count: Number(input || 0) + 1 };',
                  export_as: 'loop',
                },
              },
            ],
          },
        },
      ],
      { loop: { count: 0 } }
    );

    expect(result.status).toBe('succeeded');
    expect((result.context.loop as any).count).toBe(3);
    expect(result.context.loop_result).toMatchObject({
      iterations: 3,
      history: expect.any(Array),
    });
  });

  it('runs retry_until_quality until the verdict is acceptable', async () => {
    const result = await runSteps(
      [
        {
          op: 'core:retry_until_quality',
          params: {
            max_iterations: 4,
            export_as: 'quality_result',
            pipeline: [
              {
                op: 'core:transform',
                params: {
                  input: '{{quality_count}}',
                  script: 'return Number(input || 0) + 1;',
                  export_as: 'quality_count',
                },
              },
              {
                op: 'core:transform',
                params: {
                  input: '{{quality_count}}',
                  script: 'const count = Number(input || 0); return count >= 2 ? "ok" : "pending";',
                  export_as: 'verdict',
                },
              },
            ],
          },
        },
      ],
      { quality_count: 0, verdict: 'pending' }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.quality_count).toBe(2);
    expect(result.context.quality_result).toMatchObject({
      iterations: 2,
      history: expect.any(Array),
    });
  });

  it('passes effort and budget through reasoning steps', () => {
    const policy = normalizeReasoningPolicy({
      op: 'reasoning:synthesize',
      effort: 'high',
      budget: {
        cost_cap_tokens: 1234,
        max_prompt_chars: 10_000,
        max_response_chars: 10_000,
        max_combined_chars: 20_000,
        approval_required: true,
      },
      params: {},
    });

    expect(policy).toMatchObject({
      effort: 'high',
      budget: {
        cost_cap_tokens: 1234,
        max_prompt_chars: 10_000,
        max_response_chars: 10_000,
        max_combined_chars: 20_000,
        approval_required: true,
      },
    });
    expect(buildReasoningPolicyNote(policy)).toContain('effort=high');
    expect(buildReasoningPolicyNote(policy)).toContain('cost_cap_tokens=1234');
  });

  it('halts reasoning steps when the declared budget is too small', () => {
    const policy = normalizeReasoningPolicy({
      op: 'reasoning:synthesize',
      params: {},
      budget: {
        max_prompt_chars: 1,
        approval_required: true,
      },
    });

    expect(
      isReasoningBudgetExceeded(policy, 'Instruction: x\nContext: {"topic":"budget stop"}', '')
    ).toContain('prompt budget exceeded');
    expect(buildReasoningPolicyNote(policy)).toContain('approval_required=true');
  });
});

describe('validateFlow', () => {
  it('returns empty errors for a valid chain', () => {
    const errors = validateFlow([
      {
        op: 'media:pptx_extract',
        role: 'source',
        produces: { channel: 'pptx_design', type: 'PptxDesign' },
        params: {},
      },
      {
        op: 'media:theme_from_pptx',
        role: 'transform',
        consumes: 'pptx_design',
        produces: 'active_theme',
        params: {},
      },
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
      {
        op: 'media:save_brand',
        role: 'sink',
        consumes: ['active_theme', 'layout_geometry'],
        params: {},
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].missing).toContain('active_theme');
    expect(errors[0].missing).toContain('layout_geometry');
  });

  it('uses step.id as stepId when present', () => {
    const errors = validateFlow([
      {
        id: 'save_brand_step',
        op: 'media:save_brand',
        role: 'sink',
        consumes: 'missing_channel',
        params: {},
      },
    ]);
    expect(errors[0].stepId).toBe('save_brand_step');
  });

  it('satisfies consumes from initial context', () => {
    const errors = validateFlow(
      [{ op: 'media:save_brand', role: 'sink', consumes: 'active_theme', params: {} }],
      { active_theme: { colors: {} } }
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
      {
        op: 'reasoning:synthesize',
        role: 'transform',
        consumes: 'web_snapshot',
        produces: 'active_theme',
        params: {},
      },
    ]);
    expect(errors).toEqual([]);
  });
});

describe('Typed Flow role resolution', () => {
  it('fails validation before starting steps and records the failure in the trace', async () => {
    const trace = new TraceContext('pipeline:invalid-flow', { pipelineId: 'invalid-flow' });
    const sideEffects: string[] = [];
    const steps = [
      {
        id: 'would-run-first',
        op: 'core:accumulate',
        params: { target: 'items', value: 'side-effect' },
      },
      {
        id: 'invalid-consumer',
        op: 'log',
        role: 'sink',
        consumes: 'missing_channel',
        params: { template: 'unreachable' },
      },
    ];

    const result = await runValidatedSteps(steps, { sideEffects }, { trace, quiet: true });
    const finalized = trace.finalize();

    expect(result).toMatchObject({
      status: 'failed',
      results: [
        {
          op: 'flow:validate',
          status: 'failed',
          error: expect.stringContaining('missing_channel'),
        },
      ],
    });
    expect(sideEffects).toEqual([]);
    expect(finalized.rootSpan.children).toHaveLength(0);
    expect(finalized.rootSpan.events).toContainEqual(
      expect.objectContaining({
        name: 'pipeline.validation_failed',
        attributes: expect.objectContaining({
          validation_type: 'typed_flow',
          error_count: 1,
          error: expect.stringContaining('missing_channel'),
        }),
      })
    );
  });

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

    const result = await runSteps(
      [
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
      ],
      {},
      { trace }
    );

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

  it('loads and executes the checked-in workflow-as-code module', async () => {
    const workflowPath = path.resolve(
      pathResolver.rootDir(),
      'scripts/demos/workflow-as-code-example.ts'
    );
    const workflow = await readValidatedWorkflowAdf(workflowPath);
    const result = await runSteps(workflow.steps, workflow.context ?? {});

    expect(result.status).toBe('succeeded');
    expect(result.context.workflow_state).toEqual({
      status: 'ok',
      note: 'workflow-as-code example',
    });
    expect(result.context.parallel_items).toHaveLength(2);
    expect(result.context.accumulated_items.collected).toHaveLength(2);
  });
});
