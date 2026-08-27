import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TraceContext } from '@agent/core';
import { pathResolver } from '@agent/core/path-resolver';
// Both modules are loaded through the same URL specifier the pipeline entry
// uses, so the test shares one instance of the engine module graph.
const { runValidatedSteps, executePipelineFile } = await import(
  new URL('./run_pipeline.js', import.meta.url).href
);
const { MAX_PIPELINE_NESTING_DEPTH, PIPELINE_ANCESTRY_CONTEXT_KEY, sanitizeNestedPipelineContext } =
  await import(new URL('./pipeline-execution-part-control.js', import.meta.url).href);

const ROOT = pathResolver.rootDir();
const abs = (relative: string) => path.resolve(ROOT, relative);

/** A pipeline path that exists so the step clears op preflight before the guard. */
const PIPELINE_A = 'pipelines/vital-check.json';
const PIPELINE_B = 'pipelines/agent-provider-check.json';

function nestedStep(input: string) {
  return {
    id: 'nested',
    op: 'core:run_pipeline',
    role: 'source' as const,
    produces: 'nested_result',
    params: { input },
  };
}

type NestedRunnerOptions = { context?: Record<string, unknown>; quiet?: boolean };

function stubNestedRunner() {
  return vi.fn(async (_input: string, _options?: NestedRunnerOptions) => ({
    status: 'succeeded',
    results: [{ op: 'system:log', status: 'success' }],
    context: { nested_value: 'ready' },
  }));
}

/** Context the guarded dispatch handed to the nested pipeline runner. */
function childContextOf(runner: ReturnType<typeof stubNestedRunner>): Record<string, unknown> {
  return (runner.mock.calls[0]?.[1]?.context || {}) as Record<string, unknown>;
}

describe('core:run_pipeline nesting guard', () => {
  it('rejects a pipeline that includes itself, naming the cycle', async () => {
    const nestedRunner = stubNestedRunner();

    const result = await runValidatedSteps(
      [nestedStep(PIPELINE_A)],
      {},
      {
        quiet: true,
        pipelinePath: PIPELINE_A,
        runPipelineFile: nestedRunner,
      }
    );

    expect(nestedRunner).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({
      op: 'core:run_pipeline',
      status: 'failed',
      error: expect.stringContaining('[PIPELINE_NESTING_CYCLE]'),
    });
    expect(result.results[0].error).toContain(`${PIPELINE_A} -> ${PIPELINE_A}`);
  });

  it('detects an A -> B -> A cycle and reports the whole path', async () => {
    const nestedRunner = stubNestedRunner();

    // The engine is currently executing B, reached from A; B now asks for A.
    const result = await runValidatedSteps(
      [nestedStep(PIPELINE_A)],
      { [PIPELINE_ANCESTRY_CONTEXT_KEY]: [abs(PIPELINE_A), abs(PIPELINE_B)] },
      { quiet: true, pipelinePath: PIPELINE_B, runPipelineFile: nestedRunner }
    );

    expect(nestedRunner).not.toHaveBeenCalled();
    expect(result.results[0].error).toContain('[PIPELINE_NESTING_CYCLE]');
    expect(result.results[0].error).toContain(`${PIPELINE_A} -> ${PIPELINE_B} -> ${PIPELINE_A}`);
  });

  it('fails once the nesting stack exceeds the maximum depth', async () => {
    const nestedRunner = stubNestedRunner();
    const ancestry = Array.from({ length: MAX_PIPELINE_NESTING_DEPTH }, (_unused, index) =>
      abs(`pipelines/_depth-fixture-${index}.json`)
    );

    const result = await runValidatedSteps(
      [nestedStep(PIPELINE_A)],
      { [PIPELINE_ANCESTRY_CONTEXT_KEY]: ancestry },
      { quiet: true, pipelinePath: PIPELINE_B, runPipelineFile: nestedRunner }
    );

    expect(nestedRunner).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      op: 'core:run_pipeline',
      status: 'failed',
      error: expect.stringContaining('[PIPELINE_NESTING_DEPTH]'),
    });
    expect(result.results[0].error).toContain(String(MAX_PIPELINE_NESTING_DEPTH));
  });

  it('allows nesting up to the maximum depth and records the ancestry', async () => {
    const nestedRunner = stubNestedRunner();
    const ancestry = Array.from({ length: MAX_PIPELINE_NESTING_DEPTH - 1 }, (_unused, index) =>
      abs(`pipelines/_depth-fixture-${index}.json`)
    );

    const result = await runValidatedSteps(
      [nestedStep(PIPELINE_A)],
      { [PIPELINE_ANCESTRY_CONTEXT_KEY]: ancestry },
      { quiet: true, pipelinePath: PIPELINE_B, runPipelineFile: nestedRunner }
    );

    expect(result.status).toBe('succeeded');
    expect(nestedRunner).toHaveBeenCalledTimes(1);
    expect(childContextOf(nestedRunner)[PIPELINE_ANCESTRY_CONTEXT_KEY]).toEqual([
      ...ancestry,
      abs(PIPELINE_A),
    ]);
  });
});

describe('core:run_pipeline child context isolation', () => {
  it('forwards user data but not the parent engine context', async () => {
    const nestedRunner = stubNestedRunner();

    const result = await runValidatedSteps(
      [nestedStep(PIPELINE_A)],
      {
        // User-level channels the parent produced.
        greeting: 'hello',
        mission_id: 'MISSION-1',
        // Engine-derived context the child must recompute for itself.
        __pipeline_options: { keep_alive: true },
        repo_root: '/parent/repo',
        run_utc_now: '1999-01-01T00:00:00.000Z',
        platform_name: 'parent-platform',
        node_options: '--parent',
        browser_session_id: 'parent-session',
        mission_dir: 'active/missions/parent',
        mission_tier: 'confidential',
        mission_evidence_dir: 'active/missions/parent/evidence',
        _knowledge_scope: { tiers: ['confidential'] },
      },
      { quiet: true, pipelinePath: PIPELINE_B, runPipelineFile: nestedRunner }
    );

    expect(result.status).toBe('succeeded');
    const childContext = childContextOf(nestedRunner);
    expect(childContext).toMatchObject({ greeting: 'hello', mission_id: 'MISSION-1' });
    for (const leaked of [
      '__pipeline_options',
      'repo_root',
      'run_utc_now',
      'platform_name',
      'node_options',
      'browser_session_id',
      'mission_dir',
      'mission_tier',
      'mission_evidence_dir',
      '_knowledge_scope',
    ]) {
      expect(childContext).not.toHaveProperty(leaked);
    }
    // The ancestry is the one engine key that is re-attached on purpose.
    expect(childContext[PIPELINE_ANCESTRY_CONTEXT_KEY]).toEqual([abs(PIPELINE_B), abs(PIPELINE_A)]);
  });

  it('still honours explicit params.context overrides', async () => {
    const nestedRunner = stubNestedRunner();

    await runValidatedSteps(
      [
        {
          ...nestedStep(PIPELINE_A),
          params: { input: PIPELINE_A, context: { greeting: 'override' } },
        },
      ],
      { greeting: 'parent', repo_root: '/parent/repo' },
      { quiet: true, pipelinePath: PIPELINE_B, runPipelineFile: nestedRunner }
    );

    const childContext = childContextOf(nestedRunner);
    expect(childContext.greeting).toBe('override');
    expect(childContext).not.toHaveProperty('repo_root');
  });

  it('sanitizeNestedPipelineContext drops the engine private namespace', () => {
    expect(
      sanitizeNestedPipelineContext({
        keep: 1,
        __pipeline_options: {},
        __future_engine_key: 'x',
        repo_root: '/x',
      })
    ).toEqual({ keep: 1 });
  });
});

describe('executePipelineFile engine context ownership', () => {
  it('computes its own engine context instead of inheriting a caller override', async () => {
    const result = await executePipelineFile(
      'pipelines/fragments/_test-run-pipeline-include.json',
      {
        quiet: true,
        trace: new TraceContext('pipeline:nesting-context-ownership', {
          pipelineId: 'nesting-context-ownership',
        }),
        context: {
          greeting: 'hello',
          __pipeline_options: { keep_alive: true },
          repo_root: '/parent/repo',
          run_utc_now: '1999-01-01T00:00:00.000Z',
        },
      }
    );

    expect(result.status).toBe('succeeded');
    expect(result.context.fragment_result).toBe('hello from fragment');
    expect(result.context.repo_root).toBe(ROOT);
    expect(result.context.__pipeline_options).toEqual({});
    expect(result.context.run_utc_now).not.toBe('1999-01-01T00:00:00.000Z');
  });
});
