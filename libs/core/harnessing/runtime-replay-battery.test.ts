import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleBackend } from '../provider/openai-compatible-backend.js';
import { runGoalDrivenLoop } from '../workforce/worker-goal-driver.js';
import { parseClaudeCliUsage, parseCodexCliUsage } from '../cli-usage-metering.js';
import { resolveUsageCostAccounting } from '../usage-accounting.js';
import { classifyProbeSet } from './decision-axis.js';
import type { RunOutcome } from './probe-runner.js';

// Exercise the real goal driver, provider request/response validation and CLI
// transport parser; only outbound transport and observability writes are fake.
vi.mock('../secure-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secure-io.js')>()),
  safeAppendFileSync: vi.fn(),
  safeMkdir: vi.fn(),
  safeWriteFile: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function response(status: 'continue' | 'complete', turn: number): Response {
  const wire = JSON.parse(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `turn-${turn}`,
                type: 'function',
                function: {
                  name: 'goal_update',
                  arguments: JSON.stringify({ status, reason: `verified step ${turn}` }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 97_531, completion_tokens: 127 },
    })
  );
  return new Response(JSON.stringify(wire), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Hermes adoption runtime replay battery (fake provider)', () => {
  it('runs validated provider turns beyond the old implicit cap with per-step admission', async () => {
    let turn = 0;
    let admitted = 0;
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(
        request.tools.some(
          (tool: { function: { name: string } }) => tool.function.name === 'goal_update'
        )
      ).toBe(true);
      turn += 1;
      return response(turn === 105 ? 'complete' : 'continue', turn);
    });
    vi.stubGlobal('fetch', transport);
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'fake',
    });
    const result = await runGoalDrivenLoop({
      objective: 'verify every step',
      backend,
      executionMode: 'continuous',
      preStep: [
        () => {
          admitted += 1;
          return { decision: 'enter' };
        },
      ],
    });
    expect(result).toMatchObject({ finalState: 'complete', turnsRun: 105 });
    expect(admitted).toBe(105);
    expect(transport).toHaveBeenCalledTimes(105);
  });

  it('rejects malformed provider tool output before executing an external effect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'bad',
                        type: 'function',
                        function: { name: 'goal_update', arguments: '{"status":"invented"}' },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'fake',
    });
    const executeTool = vi.fn();
    await expect(
      runGoalDrivenLoop({ objective: 'reject invalid output', backend, executeTool })
    ).rejects.toThrow('[OPENAI_TOOL_ARGUMENTS_SCHEMA_INVALID]');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not accept a late successful response after cancellation', async () => {
    let release!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const backend = new OpenAiCompatibleBackend({
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-needed',
      model: 'fake',
    });
    const run = runGoalDrivenLoop({ objective: 'cancel me', backend, signal: controller.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancelled by operator'));
    const result = await run;
    release(response('complete', 1));
    await Promise.resolve();
    expect(result.finalState).toBe('paused');
    expect(result.persisted?.status).not.toBe('complete');
  });

  it('keeps native usage through JSON round-trip and never treats missing cost as free', () => {
    const terminal = {
      type: 'result',
      total_cost_usd: 5,
      usage: { input_tokens: 97_531, output_tokens: 127, cache_read_input_tokens: 11 },
    };
    const direct = parseClaudeCliUsage(JSON.stringify(terminal));
    const replay = parseClaudeCliUsage(JSON.stringify(JSON.parse(JSON.stringify(terminal))));
    expect(replay).toEqual(direct);
    expect(replay?.entries[0]?.usage.prompt_tokens).toBe(97_531);
    expect(replay?.entries[0]?.usage.cache_read_tokens).toBe(11);
    expect(
      resolveUsageCostAccounting({ billing_mode: 'unknown', reference_cost_usd: 5 })
    ).toMatchObject({ cost_usd: null, cost_status: 'unknown', reference_cost_usd: 5 });
    expect(
      parseCodexCliUsage(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 444, cached_input_tokens: 44, output_tokens: 12 },
        })
      )?.entries[0]?.usage
    ).toMatchObject({ prompt_tokens: 400, cache_read_tokens: 44, completion_tokens: 12 });
  });

  it('does not advance a cheaper faster candidate that fails the delivery quality gate', () => {
    const outcome = (label: string, delivered: boolean, wall_ms: number): RunOutcome => ({
      label,
      delivered,
      wall_ms,
      ok: true,
      exit_code: 0,
      run_dir: label,
      produced_files: [],
      staged_expected: [],
      error: '',
      recorded_at: '2026-10-28T00:00:00Z',
    });
    expect(
      classifyProbeSet(
        outcome('base', true, 100),
        [outcome('cheap', false, 1)],
        [{ key: 'wall_ms', direction: 'lower' }]
      )
    ).toMatchObject({ decision: 'keep_base', auto_advance_allowed: false });
  });
});
