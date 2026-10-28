import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from './metrics.js';
import {
  cliOutputFormat,
  parseClaudeCliUsage,
  parseCodexCliUsage,
  parseGeminiCliUsage,
  recordCliUsage,
  recordEstimatedCliUsage,
} from './cli-usage-metering.js';
import { withUsageAttribution } from './usage-accounting.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordEstimatedCliUsage (OP-01)', () => {
  it('records estimated tokens with the estimated flag and mission attribution', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    const previousMission = process.env.MISSION_ID;
    process.env.MISSION_ID = 'MSN-METER-1';
    try {
      recordEstimatedCliUsage('gemini-cli', 'gemini-test', Date.now() - 5, 'success', 400, 80);
    } finally {
      if (previousMission === undefined) delete process.env.MISSION_ID;
      else process.env.MISSION_ID = previousMission;
    }

    expect(spy).toHaveBeenCalledOnce();
    const [component, , status, extra] = spy.mock.calls[0];
    expect(component).toBe('gemini-cli');
    expect(status).toBe('success');
    expect(extra).toMatchObject({
      model: 'gemini-test',
      estimated: true,
      billing_mode: 'unknown',
      usage_source: 'character_estimate',
      mission_id: 'MSN-METER-1',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
  });

  it('carries trusted usage attribution so dot wakes on CLI backends reconcile', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    recordEstimatedCliUsage('codex-cli', 'codex-test', Date.now(), 'success', 40, 8);
    expect(spy.mock.calls[0][3]).not.toHaveProperty('scope');
    withUsageAttribution(
      {
        actor_id: 'dot:a',
        accounting_id: 'wake-1',
        scope: { tier: 'confidential', tenant_slug: 'acme' },
      },
      () => recordEstimatedCliUsage('codex-cli', 'codex-test', Date.now(), 'success', 40, 8)
    );
    expect(spy.mock.calls[1][3]).toMatchObject({
      actor_id: 'dot:a',
      accounting_id: 'wake-1',
      scope: { tenant_slug: 'acme' },
    });
  });

  it('never throws when the metrics collector fails', () => {
    vi.spyOn(metrics, 'record').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() =>
      recordEstimatedCliUsage('codex-cli', 'codex-test', Date.now(), 'error', 10, 0)
    ).not.toThrow();
  });
});

describe('native CLI usage envelopes', () => {
  it('prefers the Claude terminal aggregate over assistant snapshots and model totals', () => {
    const output = [
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 50, output_tokens: 3 } } },
      {
        type: 'result',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_1h_input_tokens: 10 },
        },
        modelUsage: { opus: { inputTokens: 100, outputTokens: 20 } },
        total_cost_usd: 0,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    expect(parseClaudeCliUsage(output)?.entries).toEqual([
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cache_read_tokens: 80,
          cache_write_tokens: 20,
          cache_write_1h_tokens: 10,
        },
        referenceCostUsd: 0,
      },
    ]);
  });

  it('uses per-model Claude totals only when no terminal aggregate is available', () => {
    const report = parseClaudeCliUsage(
      JSON.stringify({
        type: 'result',
        total_cost_usd: 8,
        modelUsage: {
          first: { inputTokens: 10, outputTokens: 2, costUSD: 0 },
          second: { inputTokens: 20, outputTokens: 4, costUSD: 0.2 },
        },
      })
    );
    expect(
      report?.entries.map((entry) => [
        entry.model,
        entry.usage.prompt_tokens,
        entry.referenceCostUsd,
      ])
    ).toEqual([
      ['first', 10, 0],
      ['second', 20, 0.2],
    ]);
    expect(report).not.toHaveProperty('referenceCostUsd');
  });

  it('replaces repeated Claude message snapshots and ignores model-authored usage text', () => {
    const snapshots = [2, 5]
      .map((tokens) =>
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', model: 'opus', usage: { input_tokens: 10, output_tokens: tokens } },
        })
      )
      .join('\n');
    expect(parseClaudeCliUsage(snapshots)?.entries).toEqual([
      { model: 'opus', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    expect(
      parseClaudeCliUsage(
        JSON.stringify({
          type: 'result',
          result: JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }),
        })
      )
    ).toBeUndefined();
  });

  it('uses the final Codex exec snapshot once and keeps cached input disjoint', () => {
    const row = {
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 60,
        output_tokens: 15,
        reasoning_output_tokens: 10,
        cache_write_input_tokens: 5,
      },
    };
    const report = parseCodexCliUsage([row, row].map((value) => JSON.stringify(value)).join('\n'));
    expect(report?.entries).toEqual([
      { usage: { prompt_tokens: 40, cache_read_tokens: 60, completion_tokens: 15 } },
    ]);
    expect(
      parseCodexCliUsage(
        JSON.stringify({ type: 'item.completed', item: { text: JSON.stringify(row) } })
      )
    ).toBeUndefined();
  });

  it('uses Gemini per-model totals without adding role and total counters twice', () => {
    const report = parseGeminiCliUsage(
      'Startup notice\n' +
        JSON.stringify(
          {
            response: 'answer',
            stats: {
              models: {
                first: {
                  tokens: {
                    prompt: 100,
                    input: 60,
                    cached: 40,
                    candidates: 8,
                    thoughts: 12,
                    total: 120,
                  },
                  roles: { main: { tokens: { prompt: 100 } } },
                },
                second: { tokens: { input: 30, cached: 10, candidates: 4 } },
              },
            },
          },
          null,
          2
        )
    );
    expect(report?.entries).toEqual([
      {
        model: 'first',
        usage: { prompt_tokens: 60, completion_tokens: 20, cache_read_tokens: 40 },
      },
      {
        model: 'second',
        usage: { prompt_tokens: 30, completion_tokens: 4, cache_read_tokens: 10 },
      },
    ]);
  });

  it('does not treat malformed counts, unknown envelopes, or text-result JSON as actual usage', () => {
    expect(
      parseCodexCliUsage(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 2, cached_input_tokens: 3, output_tokens: 1 },
        })
      )
    ).toBeUndefined();
    expect(
      parseCodexCliUsage(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 2, cached_input_tokens: -1, output_tokens: 1 },
        })
      )
    ).toBeUndefined();
    expect(
      parseClaudeCliUsage(
        JSON.stringify({ type: 'result', usage: { input_tokens: '20', output_tokens: 1 } })
      )
    ).toBeUndefined();
    expect(
      parseGeminiCliUsage(
        JSON.stringify({
          response: JSON.stringify({
            stats: { models: { fake: { tokens: { prompt: 100, candidates: 1 } } } },
          }),
        })
      )
    ).toBeUndefined();
    expect(parseGeminiCliUsage('{bad JSON')).toBeUndefined();
    expect(cliOutputFormat(['-o', 'json', '--output-format=text'])).toBe('text');
    for (const cache_creation of [
      { ephemeral_1h_input_tokens: -1 },
      { ephemeral_1h_input_tokens: '3' },
      'invalid',
    ]) {
      expect(
        parseClaudeCliUsage(
          JSON.stringify({
            type: 'result',
            usage: {
              input_tokens: 20,
              output_tokens: 1,
              cache_creation_input_tokens: 5,
              cache_creation,
            },
          })
        )
      ).toBeUndefined();
    }
  });

  it('records multi-model totals under one trusted accounting attribution without folding them away', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    const report = parseGeminiCliUsage(
      JSON.stringify({
        response: 'ok',
        stats: {
          models: {
            first: { tokens: { prompt: 100, cached: 20, candidates: 5 } },
            second: { tokens: { prompt: 200, cached: 40, candidates: 10 } },
          },
        },
      })
    );
    withUsageAttribution(
      {
        actor_id: 'dot:a',
        accounting_id: 'one-request',
        scope: { tier: 'confidential', tenant_slug: 'acme' },
      },
      () =>
        recordCliUsage('gemini-cli', 'fallback', Date.now(), 'success', {
          report,
          promptChars: 1,
          completionChars: 1,
        })
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((call) => call[3].model)).toEqual(['first', 'second']);
    for (const call of spy.mock.calls)
      expect(call[3]).toMatchObject({
        accounting_id: 'one-request',
        scope: { tenant_slug: 'acme' },
        usage_source: 'provider',
        estimated: false,
        billing_mode: 'unknown',
      });
    expect(
      spy.mock.calls.reduce(
        (total, call) => total + call[3].usage.prompt_tokens + call[3].usage.cache_read_tokens,
        0
      )
    ).toBe(300);
  });

  it('retains CLI reference cost including zero without labeling it an actual charge', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    recordCliUsage('claude-cli', 'opus', Date.now(), 'success', {
      promptChars: 20,
      completionChars: 10,
      report: parseClaudeCliUsage(
        JSON.stringify({
          type: 'result',
          total_cost_usd: 0,
          usage: { input_tokens: 10, output_tokens: 2 },
        })
      ),
    });
    expect(spy.mock.calls[0][3]).toMatchObject({
      reference_cost_usd: 0,
      cost_source: 'provider_report',
      billing_mode: 'unknown',
      usage_source: 'provider',
    });
    expect(spy.mock.calls[0][3]).not.toHaveProperty('reported_cost_usd');
    expect(spy.mock.calls[0][3]).not.toHaveProperty('sdk_cost_usd');
  });

  it('does not invent token charges after failed or unsent calls', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    for (const options of [{ requestNotSent: true }, {}]) {
      recordCliUsage('codex-cli', 'gpt', Date.now(), 'error', {
        promptChars: 800,
        completionChars: 0,
        ...options,
      });
    }
    for (const call of spy.mock.calls) {
      expect(call[3]).toMatchObject({
        cost_status: 'unknown',
        usage_source: 'unknown',
        cost_source: 'none',
      });
      expect(call[3]).not.toHaveProperty('usage');
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not estimate usage for error envelopes even when a CLI exits zero', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    for (const report of [
      parseClaudeCliUsage('{"type":"result","is_error":true,"result":"auth unavailable"}'),
      parseGeminiCliUsage('{"error":{"message":"auth unavailable"}}'),
    ]) {
      recordCliUsage('cli', 'model', Date.now(), 'success', {
        report,
        promptChars: 800,
        completionChars: 80,
      });
    }
    for (const call of spy.mock.calls) {
      expect(call[2]).toBe('error');
      expect(call[3]).toMatchObject({ cost_status: 'unknown', usage_source: 'unknown' });
      expect(call[3]).not.toHaveProperty('usage');
    }
  });
});
