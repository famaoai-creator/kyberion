import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TraceContext } from '@agent/core';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  createPipelineRunJournal,
  decideApprovalRequest,
  loadApprovalRequest,
  loadPipelineRunJournal,
  approvalRequestLogicalPath,
  safeRmSync,
  safeWriteFile,
  withExecutionContext,
  getDefaultLifecycleHookEngine,
  resetDefaultLifecycleHookEngine,
} from '@agent/core';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
import { runInlineProductivityScore } from './pipeline-domain-ops.js';
import {
  DEFAULT_CORE_WAIT_MS,
  resolveReasoningContextParam,
  resolveWaitDurationMs,
} from './pipeline-execution-part-bootstrap.js';

const {
  normalizePipelineOp,
  runSteps,
  runValidatedSteps,
  executePipelineFile,
  recordFallbackOutcome,
  finalizePipelineTrace,
  formatPipelineFailure,
  validateFlow,
  normalizeReasoningPolicy,
  buildReasoningPolicyNote,
  isReasoningBudgetExceeded,
  findStepByIdRecursive,
  resolvePipelinePresetArgs,
} = await import(new URL('./run_pipeline.js', import.meta.url).href);

describe('pipeline preset routing', () => {
  it('expands governed preset names into the existing input contract', () => {
    expect(resolvePipelinePresetArgs(['vital-check', '--json'])).toEqual([
      '--input',
      'pipelines/vital-check.json',
      '--json',
    ]);
  });

  it('preserves explicit input and unknown arguments', () => {
    expect(resolvePipelinePresetArgs(['--input', 'pipelines/custom.json'])).toEqual([
      '--input',
      'pipelines/custom.json',
    ]);
    expect(resolvePipelinePresetArgs(['unknown-preset'])).toEqual(['unknown-preset']);
  });
});

describe('findStepByIdRecursive', () => {
  it('finds a step nested inside core:if/core:foreach/on_error.fallback by id', () => {
    const steps = [
      { id: 'top-shell', op: 'system:shell', params: {} },
      {
        id: 'gate',
        op: 'core:if',
        params: {
          condition: {},
          then: [
            {
              id: 'nested-shell',
              op: 'system:shell',
              params: { cmd: 'echo nested' },
              on_error: { fallback: [{ id: 'fallback-shell', op: 'system:shell', params: {} }] },
            },
          ],
        },
      },
    ];

    expect(findStepByIdRecursive(steps, 'nested-shell')).toMatchObject({
      id: 'nested-shell',
      params: { cmd: 'echo nested' },
    });
    expect(findStepByIdRecursive(steps, 'fallback-shell')).toMatchObject({ id: 'fallback-shell' });
  });

  it('does not match a same-op step in an unrelated location (regression)', () => {
    // Two steps share the op "system:shell" but only one has the id we're
    // looking for — matching by op alone (the pre-fix behavior) would have
    // returned the wrong one.
    const steps = [
      { id: 'top-shell', op: 'system:shell', params: { cmd: 'echo unrelated' } },
      {
        id: 'gate',
        op: 'core:if',
        params: {
          condition: {},
          then: [{ id: 'nested-shell', op: 'system:shell', params: { cmd: 'echo target' } }],
        },
      },
    ];

    const found = findStepByIdRecursive(steps, 'nested-shell');
    expect(found?.params).toMatchObject({ cmd: 'echo target' });
    expect(findStepByIdRecursive(steps, 'missing-id')).toBeUndefined();
  });
});

describe('typed pipeline domain operations', () => {
  it('computes productivity score from resolved shell metrics without eval', () => {
    const result = runInlineProductivityScore(
      { op: 'core:calculate_productivity_score', role: 'transform', produces: 'score' } as any,
      {
        ts_file_count: '{{ts_file_count}}',
        test_file_count: '{{test_file_count}}',
        fixme_count: '{{fixme_count}}',
      },
      { ts_file_count: '3126\n', test_file_count: '1033\n', fixme_count: '0\n' }
    );
    expect(result.score).toBe(33);
  });
});

describe('run_pipeline compatibility', () => {
  type TestSuspension = {
    step_id: string;
    approval_request_id: string;
    storage_channel: string;
    on_timeout: 'abort' | 'deny' | 'escalate';
    timeout_at?: string;
    reason?: string;
  };

  it('executes a validated pipeline file in-process through the shared lifecycle', async () => {
    const result = await executePipelineFile(
      'pipelines/fragments/_test-run-pipeline-include.json',
      {
        context: { greeting: 'hello' },
        quiet: true,
        trustResolved: true,
        trace: new TraceContext('pipeline:library-entry', { pipelineId: 'library-entry' }),
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.fragment_result).toBe('hello from fragment');
    expect(result.context.trace_persisted_path).toContain('active/shared/logs/traces/');
  });

  it('propagates an unresolved trust decision before importing workflow modules', async () => {
    await expect(
      executePipelineFile('scripts/demos/workflow-as-code-example.ts', {
        quiet: true,
        trustResolved: false,
      })
    ).rejects.toThrow('[TRUST_REQUIRED] project-local pipeline/template');
  });

  it('does not let a nested pipeline widen an unresolved parent trust decision', async () => {
    const parentPath = pathResolver.sharedTmp(`run-pipeline-trust-propagation-${process.pid}.json`);
    safeWriteFile(
      parentPath,
      JSON.stringify({
        pipeline_id: 'trust-propagation-parent',
        steps: [
          {
            op: 'core:run_pipeline',
            params: { input: 'pipelines/vital-check.json', export_as: 'nested_result' },
          },
        ],
      })
    );
    try {
      await expect(
        executePipelineFile(parentPath, {
          quiet: true,
          trustResolved: false,
        })
      ).rejects.toThrow('[TRUST_REQUIRED] project-local pipeline/template');
    } finally {
      safeRmSync(parentPath);
    }
  });

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
    expect(normalizePipelineOp('parallel_calls')).toBe('core:parallel_calls');
    expect(normalizePipelineOp('accumulate')).toBe('core:accumulate');
    expect(normalizePipelineOp('system:shell')).toBe('system:shell');
    expect(normalizePipelineOp('judge_route')).toBe('core:judge_route');
    expect(normalizePipelineOp('await_decision')).toBe('core:await_decision');
  });

  it('routes a deterministic judge fixture to the selected step', async () => {
    const result = await runSteps([
      {
        id: 'judge',
        op: 'core:judge_route',
        params: {
          fixture: true,
          verdict: { label: 'approve', reason: 'fixture' },
          export_as: 'selected_route',
          routes: [
            { when: { label: 'approve' }, next: 'approved' },
            { when: { label: 'reject' }, next: 'rejected' },
          ],
        },
      },
      { id: 'rejected', op: 'log', params: { message: 'must not run' } },
      { id: 'approved', op: 'log', params: { message: 'approved' } },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.results.map((entry) => entry.status)).toEqual(['success', 'skipped', 'success']);
    expect(result.context.selected_route).toMatchObject({ next: 'approved', matched: true });
  });

  it('fails closed when a judge fixture has no matching route', async () => {
    const result = await runSteps([
      {
        id: 'judge',
        op: 'core:judge_route',
        params: {
          fixture: true,
          verdict: { label: 'unknown' },
          routes: [{ when: { label: 'approve' }, next: 'approved' }],
        },
      },
      { id: 'approved', op: 'log', params: { message: 'not reached' } },
    ]);

    expect(result.status).toBe('failed');
    expect(result.results.some((entry) => entry.error?.includes('JUDGE_ROUTE_ABORT'))).toBe(true);
  });

  it('suspends at await_decision and resumes after the approval-store decision', async () => {
    const runId = `await-decision-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: 'await-decision-test',
      input_path: 'pipelines/example.json',
      step_ids: ['before', 'approval', 'after'],
    });
    let suspension: TestSuspension | undefined;
    try {
      await runSteps(
        [
          { id: 'before', op: 'log', params: { message: 'before' } },
          {
            id: 'approval',
            op: 'core:await_decision',
            params: {
              approval: { title: 'Test approval', summary: 'Resume the test pipeline.' },
              approval_for: 'after',
              export_as: 'after_approval',
              timeout_ms: 60_000,
            },
          },
          {
            id: 'after',
            op: 'log',
            params: { message: 'after' },
            budget: { approval_required: true, approval_ref: 'after_approval' },
          },
        ],
        {},
        { runJournal: journal, runId, quiet: true }
      );
      throw new Error('expected await_decision to suspend');
    } catch (error) {
      if (!error || typeof error !== 'object' || !('suspension' in error)) throw error;
      suspension = (error as { suspension: TestSuspension }).suspension;
    }

    if (!suspension) throw new Error('await_decision did not expose suspension metadata');
    expect(suspension).toMatchObject({ step_id: 'approval', on_timeout: 'abort' });
    journal.append('run_suspended', { ...suspension });
    const suspendedState = loadPipelineRunJournal(runId);
    journal.append('run_resumed', { resumed_at: new Date().toISOString() });
    const approval = loadApprovalRequest('pipeline-approval', suspension.approval_request_id);
    expect(approval?.status).toBe('pending');
    expect(approval?.requestedByContext).toMatchObject({
      actorId: `pipeline:${runId}`,
      pipelineRunId: runId,
      stepId: 'approval',
    });
    decideApprovalRequest('mission_controller', {
      channel: 'pipeline-approval',
      requestId: suspension.approval_request_id,
      decision: 'approved',
      decidedBy: 'test-operator',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'manual',
    });

    const resumed = await runSteps(
      [
        { id: 'before', op: 'log', params: { message: 'before' } },
        {
          id: 'approval',
          op: 'core:await_decision',
          params: {
            approval: { title: 'Test approval', summary: 'Resume the test pipeline.' },
            approval_for: 'after',
            export_as: 'after_approval',
            timeout_ms: 60_000,
          },
        },
        {
          id: 'after',
          op: 'log',
          params: { message: 'after' },
          budget: { approval_required: true, approval_ref: 'after_approval' },
        },
      ],
      {},
      { runJournal: journal, resumeState: suspendedState, runId, quiet: true }
    );
    expect(resumed.status).toBe('succeeded');

    withExecutionContext('mission_controller', () => {
      safeRmSync(journal.path);
      safeRmSync(approvalRequestLogicalPath('pipeline-approval', suspension.approval_request_id));
    });
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

  it('applies post-tool result patches before the next step consumes context', async () => {
    const dispose = getDefaultLifecycleHookEngine().register({
      id: 'run-pipeline-result-patch-test',
      event: 'post_tool_use',
      matcher: '^system:log$',
      handler: () => ({ block: false, result_patch: { patched_by_hook: 'yes' } }),
    });
    try {
      const result = await runSteps([
        { op: 'log', params: { message: 'patch me' } },
        { op: 'log', params: { template: 'patched={{patched_by_hook}}' } },
      ]);
      expect(result.status).toBe('succeeded');
      expect(result.context.patched_by_hook).toBe('yes');
    } finally {
      dispose();
      resetDefaultLifecycleHookEngine();
    }
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

  it('blocks an approval-gated step when the pipeline has no human present', async () => {
    const result = await runSteps(
      [
        {
          op: 'system:log',
          params: { message: 'must not run' },
          budget: { approval_required: true },
        },
      ],
      {},
      { hasHuman: false, quiet: true }
    );

    expect(result.status).toBe('failed');
    expect(result.results[0]?.error).toContain('[HUMAN_REQUIRED]');
  });

  it('does not accept a forged or unbound approval-shaped context', async () => {
    const result = await runSteps(
      [
        {
          id: 'effect',
          op: 'system:log',
          params: { message: 'must not run' },
          budget: { approval_required: true, approval_ref: 'approval' },
        },
      ],
      {
        _approval_granted: true,
        approval: { status: 'approved' },
      },
      { hasHuman: false, quiet: true }
    );

    expect(result.status).toBe('failed');
    expect(result.results[0]?.error).toContain('[HUMAN_REQUIRED]');
  });

  it('dispatches core:ptc through typed ops and records the call trace', async () => {
    const trace = new TraceContext('pipeline:ha04-ptc', { pipelineId: 'ha04-ptc' });
    const result = await runSteps(
      [
        {
          id: 'ptc-step',
          op: 'core:ptc',
          params: {
            code: `
              const value = await callOp('system:json_query', { from: 'seed_data', path: 'status' });
              console.log(JSON.stringify({ status: value }));
            `,
            allowed_ops: ['system:json_query'],
            granted_ops: ['system:json_query'],
            export_as: 'ptc_stdout',
          },
        },
      ],
      { seed_data: { status: 'accepted' } },
      { trace, quiet: true }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.ptc_stdout).toBe('{"status":"accepted"}');
    const finalized = trace.finalize();
    const ptcSpan = finalized.rootSpan.children.find((span) => span.name === 'core:ptc');
    expect(ptcSpan?.events).toContainEqual(
      expect.objectContaining({
        name: 'ptc.op_call',
        attributes: expect.objectContaining({
          op: 'system:json_query',
          status: 'succeeded',
        }),
      })
    );
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

  it('offloads oversized ADF step output and records it on the step trace', async () => {
    const trace = new TraceContext('pipeline:oh04-test', { pipelineId: 'oh04-test' });
    const result = await runSteps(
      [
        {
          op: 'system:exec',
          params: {
            command: 'node',
            args: ['-e', 'process.stdout.write("z".repeat(20000))'],
            export_as: 'exec_result',
          },
        },
      ],
      { __pipeline_options: { max_inline_output_chars: 1000 } },
      { trace, quiet: true }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.exec_result).toMatchObject({ truncated: true });
    expect((result.context.exec_result as any).artifact_path).toMatch(
      /^active\/shared\/tmp\/tool-output\//
    );
    expect(trace.summary().artifacts).toBe(1);
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

  it('selects a bounded subset from a runtime pool for parallel_foreach', async () => {
    const result = await runSteps(
      [
        {
          op: 'core:parallel_foreach',
          params: {
            items_from: { pool_ref: 'candidate_pool', selection: { fixture: [0, 2] } },
            as: 'item',
            export_as: 'selected',
            do: [
              {
                op: 'core:transform',
                params: {
                  input: '{{item}}',
                  script: 'return { value: input };',
                  export_as: 'mapped',
                },
              },
            ],
          },
        },
      ],
      { candidate_pool: ['a', 'b', 'c'] }
    );
    expect(result.status).toBe('succeeded');
    expect(result.context.selected.map((entry: { item: string }) => entry.item)).toEqual([
      'a',
      'c',
    ]);
  });

  it('decomposes fixture team_lead tasks and caps worker concurrency at three', async () => {
    const result = await runSteps([
      {
        op: 'core:team_lead',
        params: {
          fixture_tasks: [
            { task_id: 'T1' },
            { task_id: 'T2' },
            { task_id: 'T3' },
            { task_id: 'T4' },
          ],
          max_concurrency: 9,
          as: 'task',
          export_as: 'team_result',
          do: [
            {
              op: 'core:transform',
              params: {
                input: '{{task.task_id}}',
                script: 'return { task_id: input };',
                export_as: 'worker',
              },
            },
          ],
        },
      },
    ]);
    expect(result.status).toBe('succeeded');
    expect(result.context.team_result.max_concurrency).toBe(3);
    expect(result.context.team_result.outputs).toHaveLength(4);
  });

  it('runs core:parallel_calls across heterogeneous ops and merges per-call context in request order (KD-07)', async () => {
    const result = await runSteps([
      {
        op: 'core:parallel_calls',
        params: {
          export_as: 'parallel_call_results',
          calls: [
            {
              op: 'core:transform',
              params: {
                input: '1',
                script: 'return { doubled: Number(input) * 2 };',
                export_as: 'first',
              },
            },
            {
              op: 'core:transform',
              params: {
                input: '2',
                script: 'return { doubled: Number(input) * 2 };',
                export_as: 'second',
              },
            },
          ],
        },
      },
    ]);

    expect(result.status).toBe('succeeded');
    expect((result.context.first as any).doubled).toBe(2);
    expect((result.context.second as any).doubled).toBe(4);
    // Per-call status report drains in request order regardless of which
    // call actually finished first (KD-07 golden ordering guarantee).
    expect(result.context.parallel_call_results).toEqual([
      { index: 0, op: 'core:transform', status: 'fulfilled' },
      { index: 1, op: 'core:transform', status: 'fulfilled' },
    ]);
  });

  it('fails the core:parallel_calls step when any call fails, surfacing its error (KD-07)', async () => {
    const result = await runSteps([
      {
        op: 'core:parallel_calls',
        params: {
          calls: [
            {
              op: 'core:transform',
              params: { input: '1', script: 'return { ok: true };', export_as: 'ok_result' },
            },
            { op: 'system:open_url', params: {} },
          ],
        },
      },
    ]);

    expect(result.status).toBe('failed');
    const failed = result.results.find(
      (entry: { status: string; error?: string }) => entry.status === 'failed'
    );
    expect(failed?.error).toContain('[INVALID_OP_INPUT]');
    expect(failed?.error).toContain('system:open_url');
  });

  it('accepts the bare "parallel_calls" op name (short-form normalization)', async () => {
    const result = await runSteps([
      {
        op: 'parallel_calls',
        params: {
          calls: [
            {
              op: 'core:transform',
              params: {
                input: '3',
                script: 'return { doubled: Number(input) * 2 };',
                export_as: 'tripled_input',
              },
            },
          ],
        },
      },
    ] as any);

    expect(result.status).toBe('succeeded');
    expect((result.context.tripled_input as any).doubled).toBe(6);
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

  it('runs core:include fragments and flattens their results (AR-01 Phase C)', async () => {
    const result = await runSteps(
      [
        { op: 'system:log', params: { message: 'before include' } },
        {
          op: 'core:include',
          params: {
            fragment: 'fragments/_test-run-pipeline-include.json',
            context: { greeting: '{{name}}' },
          },
        },
      ],
      { name: 'world' }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.fragment_result).toBe('world from fragment');
    expect(result.results).toEqual([
      { op: 'system:log', status: 'success' },
      { op: 'core:transform', status: 'success' },
      { op: 'core:include', status: 'success' },
    ]);
  });

  it('exports an include envelope and applies fragment context defaults', async () => {
    const result = await runSteps(
      [
        {
          op: 'core:include',
          params: {
            fragment: 'fragments/_test-run-pipeline-include.json',
            context: { greeting: '{{name}}' },
            export_as: 'fragment_run',
          },
        },
      ],
      { name: 'world' }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.fragment_default).toBe('fragment default');
    expect(result.context.fragment_run).toMatchObject({
      status: 'succeeded',
      results: [{ op: 'core:transform', status: 'success' }],
      context: {
        fragment_default: 'fragment default',
        fragment_result: 'world from fragment',
      },
    });
  });

  it('detects circular core:include references', async () => {
    const result = await runSteps([
      {
        op: 'core:include',
        params: { fragment: 'fragments/_test-run-pipeline-include-cycle.json' },
      },
    ]);

    expect(result.status).toBe('failed');
    const failed = result.results.find(
      (entry: { status: string; error?: string }) => entry.status === 'failed'
    );
    expect(failed?.error).toContain('circular reference detected');
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

  it('runs nested pipelines through the injected library runner', async () => {
    const nestedRunner = vi.fn(async () => ({
      status: 'succeeded',
      results: [{ op: 'system:log', status: 'success' }],
      context: { nested_value: 'ready' },
    }));

    const result = await runValidatedSteps(
      [
        {
          id: 'nested',
          op: 'core:run_pipeline',
          role: 'source',
          produces: 'nested_result',
          params: { input: 'pipelines/vital-check.json' },
        },
      ],
      {},
      { quiet: true, runPipelineFile: nestedRunner }
    );

    expect(nestedRunner).toHaveBeenCalledWith('pipelines/vital-check.json', {
      // The child inherits user-level data only; the nesting ancestry is the
      // one engine key attached on purpose (see pipeline-run-pipeline-nesting).
      context: {
        __pipeline_ancestry: [path.resolve(pathResolver.rootDir(), 'pipelines/vital-check.json')],
      },
      quiet: true,
      hasHuman: undefined,
    });
    expect(result.context.nested_result).toMatchObject({
      status: 'succeeded',
      context: { nested_value: 'ready' },
    });
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
    const workflow = await readValidatedWorkflowAdf(workflowPath, { trustResolved: true });
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

describe('falsy resolved params in inline core handlers', () => {
  // Regression guard for the class fixed in runInlineCoreTransform: params are
  // template-resolved before dispatch, so a `||` default silently discards a
  // legitimately falsy value (0 / false / '').

  describe('resolveWaitDurationMs', () => {
    it('honours an explicit zero-length wait', () => {
      expect(resolveWaitDurationMs(0)).toBe(0);
      expect(resolveWaitDurationMs('0')).toBe(0);
    });

    it('accepts finite numeric durations from either a number or a numeric string', () => {
      expect(resolveWaitDurationMs(120)).toBe(120);
      expect(resolveWaitDurationMs('250')).toBe(250);
    });

    it('treats non-durations as "not supplied" so the next alias still applies', () => {
      // '' is what resolveVars yields for an unresolved single-var template —
      // it must keep falling through to the default rather than waiting 0ms.
      expect(resolveWaitDurationMs('')).toBeUndefined();
      expect(resolveWaitDurationMs('   ')).toBeUndefined();
      expect(resolveWaitDurationMs(undefined)).toBeUndefined();
      expect(resolveWaitDurationMs(null)).toBeUndefined();
      expect(resolveWaitDurationMs(false)).toBeUndefined();
      expect(resolveWaitDurationMs('soon')).toBeUndefined();
      expect(resolveWaitDurationMs(Number.NaN)).toBeUndefined();
      expect(resolveWaitDurationMs(-1)).toBeUndefined();
    });
  });

  it('waits 0ms for core:wait with duration_ms: 0 instead of the 1000ms default', async () => {
    const startedAt = Date.now();
    const result = await runSteps([{ op: 'core:wait', params: { duration_ms: 0 } }]);
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe('succeeded');
    expect(DEFAULT_CORE_WAIT_MS).toBe(1000);
    expect(elapsed).toBeLessThan(DEFAULT_CORE_WAIT_MS / 2);
  });

  it('resolves core:wait duration_ms from a template that evaluates to 0', async () => {
    const startedAt = Date.now();
    const result = await runSteps(
      [{ op: 'core:wait', params: { duration_ms: '{{backoff_ms}}' } }],
      { backoff_ms: 0 }
    );
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe('succeeded');
    expect(elapsed).toBeLessThan(DEFAULT_CORE_WAIT_MS / 2);
  });

  describe('resolveReasoningContextParam', () => {
    const ctx = { loop: { count: 0 }, flag: false, note: 'hi' };

    it('honours a declared context that resolves to a falsy value', () => {
      expect(resolveReasoningContextParam({ context: 0 }, ctx)).toBe(0);
      expect(resolveReasoningContextParam({ context: false }, ctx)).toBe(false);
      expect(resolveReasoningContextParam({ context: '{{loop.count}}' }, ctx)).toBe(0);
      expect(resolveReasoningContextParam({ context: '{{flag}}' }, ctx)).toBe(false);
    });

    it('falls back to the whole pipeline context only when context is absent', () => {
      expect(resolveReasoningContextParam({}, ctx)).toBe(ctx);
      expect(resolveReasoningContextParam({ context: undefined }, ctx)).toBe(ctx);
      expect(resolveReasoningContextParam({ context: null }, ctx)).toBe(ctx);
    });

    it('still resolves string and array contexts element-wise', () => {
      expect(resolveReasoningContextParam({ context: '{{note}}' }, ctx)).toBe('hi');
      expect(resolveReasoningContextParam({ context: ['{{note}}', 7] }, ctx)).toEqual(['hi', 7]);
    });
  });

  it('passes a falsy core:transform input through instead of the whole context', async () => {
    const result = await runSteps(
      [
        {
          op: 'core:transform',
          params: {
            input: '{{loop_count}}',
            script: 'return { type: typeof input, value: input };',
            export_as: 'zero_probe',
          },
        },
        {
          op: 'core:transform',
          params: {
            input: false,
            script: 'return { type: typeof input, value: input };',
            export_as: 'false_probe',
          },
        },
      ],
      { loop_count: 0 }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.zero_probe).toEqual({ type: 'number', value: 0 });
    expect(result.context.false_probe).toEqual({ type: 'boolean', value: false });
  });
});
