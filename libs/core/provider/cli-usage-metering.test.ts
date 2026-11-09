import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '../analysis/metrics.js';
import {
  cliOutputFormat,
  delegationMetadataFromCliReport,
  parseAgyCliUsage,
  parseClaudeCliUsage,
  parseCodexCliUsage,
  parseCursorCliUsage,
  parseDevinCliTranscriptUsage,
  parseGeminiCliUsage,
  parseOpencodeCliUsage,
  recordCliUsage,
  recordEstimatedCliUsage,
} from './cli-usage-metering.js';
import { withUsageAttribution } from '../finance/usage-accounting.js';
import { runWithDelegationExecutionTracker } from '../workforce/delegation-execution-tracker.js';
import { pathResolver, registerMissionLocator } from '../path-resolver.js';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { resetMissionScopeCacheForTests } from '../foundation/mission-scope-env.js';
import path from 'node:path';

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

  it('reads Devin transcript final_metrics with cached input kept disjoint', () => {
    const report = parseDevinCliTranscriptUsage(
      JSON.stringify({
        schema_version: 1,
        session_id: 's-1',
        agent: 'devin',
        steps: [{ step_id: 1 }],
        final_metrics: {
          total_prompt_tokens: 18330205,
          total_completion_tokens: 64809,
          total_cached_tokens: 18189056,
          total_steps: 160,
        },
      })
    );
    expect(report?.entries).toEqual([
      {
        usage: {
          prompt_tokens: 141149,
          completion_tokens: 64809,
          cache_read_tokens: 18189056,
        },
      },
    ]);
    // Missing/malformed totals never become usage.
    expect(parseDevinCliTranscriptUsage(JSON.stringify({ final_metrics: {} }))).toBeUndefined();
    expect(
      parseDevinCliTranscriptUsage(
        JSON.stringify({
          final_metrics: { total_prompt_tokens: 10, total_cached_tokens: 20 },
        })
      )
    ).toBeUndefined();
    expect(parseDevinCliTranscriptUsage('not json')).toBeUndefined();
    expect(parseDevinCliTranscriptUsage(JSON.stringify({ steps: [] }))).toBeUndefined();
  });

  it('reads AGY result usage from stream-json events and json envelopes', () => {
    const usage = {
      input_tokens: 8870,
      output_tokens: 1,
      thinking_tokens: 4,
      cache_read_tokens: 100,
      total_tokens: 8971,
    };
    const envelope = { conversation_id: 'c', status: 'SUCCESS', response: 'OK\n', usage };
    expect(
      parseAgyCliUsage(JSON.stringify({ event: 'result', result: envelope }))?.entries
    ).toEqual([
      {
        usage: {
          prompt_tokens: 8870,
          completion_tokens: 5,
          cache_read_tokens: 100,
        },
      },
    ]);
    expect(parseAgyCliUsage(JSON.stringify(envelope))?.entries[0]?.usage.prompt_tokens).toBe(8870);
    expect(parseAgyCliUsage(JSON.stringify({ ...envelope, status: 'FAILED' }))).toMatchObject({
      isError: true,
    });
    expect(parseAgyCliUsage(JSON.stringify({ event: 'step_update' }))).toBeUndefined();
    expect(
      parseAgyCliUsage(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }))
    ).toEqual({ entries: [], isError: false });
  });

  it('reads Cursor result usage without double-counting reasoning output', () => {
    const record = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      session_id: 's',
      usage: {
        inputTokens: 8875,
        outputTokens: 27,
        cacheReadTokens: 3968,
        cacheWriteTokens: 5,
        reasoningTokens: 26,
      },
    };
    expect(parseCursorCliUsage(JSON.stringify(record))?.entries).toEqual([
      {
        usage: {
          prompt_tokens: 8875,
          completion_tokens: 27,
          cache_read_tokens: 3968,
          cache_write_tokens: 5,
        },
      },
    ]);
    expect(parseCursorCliUsage(JSON.stringify({ ...record, is_error: true }))).toMatchObject({
      isError: true,
    });
    expect(parseCursorCliUsage(JSON.stringify({ type: 'result', result: 'no usage' }))).toEqual({
      entries: [],
      isError: false,
    });
    expect(parseCursorCliUsage(JSON.stringify({ type: 'assistant' }))).toBeUndefined();
  });

  it('sums OpenCode step_finish tokens and keeps the reported cost on the entry', () => {
    const step = (tokens: unknown, cost = 0) =>
      JSON.stringify({ type: 'step_finish', part: { tokens, cost } });
    const stdout = [
      JSON.stringify({ type: 'step_start', part: {} }),
      step({ input: 4000, output: 10, reasoning: 4, cache: { read: 100, write: 0 } }, 0.01),
      step({ input: 788, output: 2, reasoning: 10, cache: { read: 0, write: 3 } }),
    ].join('\n');
    const report = parseOpencodeCliUsage(stdout);
    expect(report?.entries).toEqual([
      {
        usage: {
          prompt_tokens: 4788,
          completion_tokens: 26,
          cache_read_tokens: 100,
          cache_write_tokens: 3,
        },
        referenceCostUsd: 0.01,
      },
    ]);
    expect(parseOpencodeCliUsage(JSON.stringify({ type: 'text' }))).toBeUndefined();
    expect(parseOpencodeCliUsage('plain text')).toBeUndefined();
  });

  it('keeps AGY SDK bridge usage on the agy envelope convention', () => {
    // The SDK bridge emits an agy-style usage dict; wrapping it in a
    // transport record lets the shared parser read it unchanged.
    const report = parseAgyCliUsage(
      JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 0 },
      })
    );
    expect(report?.entries).toEqual([
      {
        usage: { prompt_tokens: 100, completion_tokens: 7, cache_read_tokens: 0 },
      },
    ]);
  });
});

describe('R5 delegation result metadata from CLI usage envelopes', () => {
  it('reports measured CLI usage and a single served model to the active delegation', async () => {
    const report = parseGeminiCliUsage(
      JSON.stringify({
        response: 'ok',
        stats: {
          models: {
            'gemini-served': { tokens: { prompt: 30, cached: 10, candidates: 7, thoughts: 3 } },
          },
        },
      })
    );
    const metadata = await runWithDelegationExecutionTracker(async (tracker) => {
      recordCliUsage('gemini-cli', 'gemini-requested', Date.now(), 'success', {
        report,
        promptChars: 1,
        completionChars: 1,
      });
      return tracker.metadata;
    });
    expect(metadata).toEqual({
      usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
      served_model: 'gemini-served',
    });
  });

  it('never reports estimated, unsent or ambiguous usage', async () => {
    const metadata = await runWithDelegationExecutionTracker(async (tracker) => {
      // Character estimates are not provider usage.
      recordCliUsage('codex-cli', 'm', Date.now(), 'success', {
        promptChars: 400,
        completionChars: 400,
      });
      // A request that was never sent consumed nothing.
      recordCliUsage('codex-cli', 'm', Date.now(), 'error', {
        report: parseCodexCliUsage(
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 1 } })
        ),
        requestNotSent: true,
        promptChars: 1,
        completionChars: 1,
      });
      return tracker.metadata;
    });
    expect(metadata).toEqual({});
    // Two different models: usage is summed but no single model served it.
    expect(
      delegationMetadataFromCliReport({
        entries: [
          { model: 'a', usage: { prompt_tokens: 1, completion_tokens: 2 } },
          { model: 'b', usage: { prompt_tokens: 3, completion_tokens: 4, cache_read_tokens: 5 } },
        ],
        referenceCostUsd: 1.5,
      })
    ).toEqual({ usage: { input_tokens: 9, output_tokens: 6, total_tokens: 15 } });
    expect(delegationMetadataFromCliReport({ entries: [], referenceCostUsd: 1 })).toBeUndefined();
  });

  it('reports the codex turn usage of a delegation', async () => {
    const metadata = await runWithDelegationExecutionTracker(async (tracker) => {
      recordCliUsage('codex-cli', 'gpt-requested', Date.now(), 'success', {
        report: parseCodexCliUsage(
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 10 },
          })
        ),
        promptChars: 1,
        completionChars: 1,
      });
      return tracker.metadata;
    });
    // The requested model is not evidence of the served one.
    expect(metadata).toEqual({
      usage: { input_tokens: 120, output_tokens: 10, total_tokens: 130 },
    });
  });
});

describe('ambient usage attribution (no ALS binding)', () => {
  const fixtureRoot = pathResolver.sharedTmp();
  const located = new Map<string, string>();
  registerMissionLocator((missionId) => located.get(missionId.toUpperCase()));

  function seedMissionState(missionId: string, state: Record<string, unknown>): void {
    const dir = path.join(fixtureRoot, `mission-scope-${process.pid}`, missionId);
    withExecutionContext('mission_controller', () => {
      safeMkdir(dir, { recursive: true });
      safeWriteFile(path.join(dir, 'mission-state.json'), JSON.stringify(state));
    });
    located.set(missionId.toUpperCase(), dir);
    resetMissionScopeCacheForTests();
  }

  afterEach(() => {
    located.clear();
    resetMissionScopeCacheForTests();
    delete process.env.MISSION_ID;
    delete process.env.KYBERION_TENANT;
  });

  it('scopes the row to the mission record when MISSION_ID is bound', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    seedMissionState('MSN-AMBIENT-1', {
      tier: 'confidential',
      tenant_slug: 'acme-corp',
      organization_id: 'org-acme',
      relationships: { project: { project_id: 'proj-9' } },
    });
    process.env.MISSION_ID = 'MSN-AMBIENT-1';

    recordCliUsage('devin-cli', 'swe', Date.now(), 'success', {
      promptChars: 80,
      completionChars: 20,
    });

    expect(spy).toHaveBeenCalledOnce();
    const extra = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(extra.scope).toMatchObject({
      scope_kind: 'mission',
      tier: 'confidential',
      tenant_slug: 'acme-corp',
      organization_id: 'org-acme',
      project_id: 'proj-9',
      mission_id: 'MSN-AMBIENT-1',
    });
    expect(extra.mission_id).toBe('MSN-AMBIENT-1');
    expect(String(extra.actor_id)).toMatch(/^kyberion:/);
  });

  it('leaves the row unscoped when the mission is not resolvable', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    process.env.MISSION_ID = 'MSN-DOES-NOT-EXIST-1';
    resetMissionScopeCacheForTests();

    recordCliUsage('devin-cli', 'swe', Date.now(), 'success', {
      promptChars: 80,
      completionChars: 20,
    });

    const extra = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(extra.mission_id).toBe('MSN-DOES-NOT-EXIST-1');
    expect(extra).not.toHaveProperty('scope');
    expect(extra).not.toHaveProperty('actor_id');
  });

  it('scopes to the tenant boundary when no mission or project is bound', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    process.env.KYBERION_TENANT = 'acme-corp';

    recordCliUsage('devin-cli', 'swe', Date.now(), 'success', {
      promptChars: 80,
      completionChars: 20,
    });

    const extra = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(extra.scope).toMatchObject({
      scope_kind: 'tenant',
      tier: 'confidential',
      tenant_slug: 'acme-corp',
    });
    expect((extra.scope as Record<string, unknown>).project_id).toBeUndefined();
    expect(String(extra.actor_id)).toMatch(/^kyberion:/);
  });

  it('explicit withUsageAttribution wins over the ambient fallback', () => {
    const spy = vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
    seedMissionState('MSN-AMBIENT-2', { tier: 'public', organization_id: 'org-wrong' });
    process.env.MISSION_ID = 'MSN-AMBIENT-2';

    withUsageAttribution(
      { actor_id: 'dot:explicit', scope: { tier: 'public', scope_kind: 'system' } },
      () =>
        recordCliUsage('devin-cli', 'swe', Date.now(), 'success', {
          promptChars: 80,
          completionChars: 20,
        })
    );

    const extra = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(extra.actor_id).toBe('dot:explicit');
    expect(extra.scope).toMatchObject({ scope_kind: 'system' });
    expect((extra.scope as Record<string, unknown>).organization_id).toBeUndefined();
  });
});
