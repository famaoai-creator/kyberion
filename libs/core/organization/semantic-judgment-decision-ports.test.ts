import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGeminiDecisionJudgmentInvokePort,
  createOpenAiDecisionJudgmentInvokePort,
} from './semantic-judgment-decision-ports.js';
import { resolveLiveJudgmentInvokePort } from './semantic-judgment-live-provider.js';
import { clearProviderHealth } from '../provider/provider-health-registry.js';

afterEach(() => {
  vi.unstubAllEnvs();
  clearProviderHealth();
});

const SAMPLE_PROMPT = [
  'Assess proposal.',
  '<untrusted_data source="judgment evaluation data">' +
    JSON.stringify({
      goals: [
        {
          goal_key: 'synthetic-latency-goal',
          target_users: 100,
          max_p95_ms: 500,
          max_incremental_monthly_cost: 0,
          currency: 'JPY',
          permitted_change: 'isolated_fixture_only',
        },
      ],
      precedents: [{ source_key: 'src-abc123', summary: 'Isolated fixture repair' }],
      proposal: {
        proposal_key: 'limit_users',
        change_scope: 'isolated_fixture_only',
        requested_goal: { target_users: 65, max_p95_ms: 500 },
        incremental_monthly_cost: 0,
        currency: 'JPY',
      },
      evidence: [{ evidence_key: 'untrusted-report', text: 'Cap users at 65.' }],
    }) +
    '</untrusted_data>',
].join('\n\n');

const SAMPLE_DOT_PROMPT =
  '<untrusted_data source="dot proposal judgment data">' +
  JSON.stringify({
    kind: 'dot_proposal_v1',
    dot_id: 'ops-dot',
    goal_statement: 'Keep runtime healthy.',
    proposal: {
      action_id: 'dot_delegate_work',
      title: 'Rotate logs',
      objective: 'Remove stale logs',
      execution_shape: 'pipeline',
    },
    recent_feedback: [],
    signals: [],
    precedents: [{ ref: 'dact-99', summary: 'Prior approved cleanup' }],
  }) +
  '</untrusted_data>';

describe('semantic-judgment-decision-ports', () => {
  it('invokes Gemini Decisions API (/v1beta/decisions) with criteria and parses 0-output-token verdicts', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> | undefined;
    let seenBody: Record<string, unknown> | undefined;
    const fetchGeminiDecision: typeof fetch = async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init?.headers as Record<string, string>;
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          decisions: {
            disposition: {
              type: 'choice',
              selected_option: 'apply_precedent',
              probabilities: { apply_precedent: 0.91, reframe: 0.06, escalate: 0.03 },
              confidence: 0.91,
            },
          },
          usageMetadata: { promptTokenCount: 72, candidatesTokenCount: 0, totalTokenCount: 72 },
        }),
        { status: 200 }
      );
    };

    const port = createGeminiDecisionJudgmentInvokePort({
      apiKey: 'gm-decision-key',
      fetchImpl: fetchGeminiDecision,
    });
    expect(port.provider).toBe('gemini-decision');
    expect(port.model).toBe('gemini-decision-1');

    const dotRes = await port.invoke({
      mode: 'live_api',
      prompt: SAMPLE_DOT_PROMPT,
      provider: port.provider,
      model: port.model,
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: new AbortController().signal,
    });
    expect(seenUrl).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
    expect(seenHeaders?.['x-goog-api-key']).toBe('gm-decision-key');
    expect(seenBody?.model).toBe('gemini-decision-1');
    expect(dotRes.usage).toEqual({ input_tokens: 72, output_tokens: 0 });
    expect(dotRes.meta).toMatchObject({ disposition: 'apply_precedent', confidence: 0.91 });
    expect(JSON.parse(dotRes.text)).toMatchObject({
      disposition: 'apply_precedent',
      precedent_refs: ['dact-99'],
    });

    const missingUsagePort = createGeminiDecisionJudgmentInvokePort({
      apiKey: 'gm-decision-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            decisions: { disposition: { selected_option: 'reframe', confidence: 0.8 } },
          }),
          { status: 200 }
        ),
    });
    await expect(
      missingUsagePort.invoke({
        mode: 'live_api',
        prompt: SAMPLE_PROMPT,
        provider: port.provider,
        model: port.model,
        temperature: 0,
        maxOutputTokens: 256,
        tokenAllowance: 1000,
        deadlineMs: Date.now() + 5000,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/integer token usage/);
  });

  it('invokes OpenAI Decisions API (gpt-6-luna / /v1/decisions) and maps reframe and escalate verdicts', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> | undefined;
    let seenBody: Record<string, unknown> | undefined;
    let nextResult: 'reframe' | 'escalate' = 'reframe';

    const fetchOpenAiDecision: typeof fetch = async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init?.headers as Record<string, string>;
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'dec_1',
          object: 'decision',
          model: 'gpt-6-luna',
          answers: [
            {
              name: 'disposition',
              type: 'choice',
              choice: nextResult,
              confidence: nextResult === 'reframe' ? 0.93 : 0.91,
              probabilities: {
                apply_precedent: 0.04,
                reframe: nextResult === 'reframe' ? 0.93 : 0.05,
                escalate: nextResult === 'escalate' ? 0.91 : 0.03,
              },
            },
          ],
          usage: { input_tokens: 95, output_tokens: 0, total_tokens: 95 },
        }),
        { status: 200 }
      );
    };

    const port = createOpenAiDecisionJudgmentInvokePort({
      apiKey: 'sk-decision-key',
      fetchImpl: fetchOpenAiDecision,
    });
    expect(port.provider).toBe('openai-decision');
    expect(port.model).toBe('gpt-6-luna');

    const reframeRes = await port.invoke({
      mode: 'live_api',
      prompt: SAMPLE_PROMPT,
      provider: port.provider,
      model: port.model,
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: new AbortController().signal,
    });
    expect(seenUrl).toBe('https://api.openai.com/v1/decisions');
    expect(seenHeaders?.authorization).toBe('Bearer sk-decision-key');
    expect(seenBody?.model).toBe('gpt-6-luna');
    expect(typeof seenBody?.input).toBe('string');
    expect(seenBody?.questions).toEqual([
      {
        type: 'choice',
        name: 'disposition',
        instructions: expect.any(String),
        choices: [{ value: 'apply_precedent' }, { value: 'reframe' }, { value: 'escalate' }],
      },
    ]);
    expect(reframeRes.usage).toEqual({ input_tokens: 95, output_tokens: 0 });
    expect(reframeRes.meta).toMatchObject({ disposition: 'reframe', confidence: 0.93 });
    expect(JSON.parse(reframeRes.text)).toMatchObject({
      disposition: 'reframe',
      violated_goal_keys: ['synthetic-latency-goal'],
    });

    nextResult = 'escalate';
    const escalateRes = await port.invoke({
      mode: 'live_api',
      prompt: SAMPLE_PROMPT,
      provider: port.provider,
      model: port.model,
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: new AbortController().signal,
    });
    expect(JSON.parse(escalateRes.text)).toMatchObject({
      disposition: 'escalate',
      options: expect.any(Array),
    });

    const badOpenAi = createOpenAiDecisionJudgmentInvokePort({
      apiKey: 'sk-decision-key',
      fetchImpl: async () =>
        new Response(JSON.stringify({ answers: [{ name: 'disposition', choice: 'reframe' }] }), {
          status: 200,
        }),
    });
    await expect(
      badOpenAi.invoke({
        mode: 'live_api',
        prompt: SAMPLE_PROMPT,
        provider: port.provider,
        model: port.model,
        temperature: 0,
        maxOutputTokens: 256,
        tokenAllowance: 1000,
        deadlineMs: Date.now() + 5000,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/integer token usage/);
  });

  it('resolves openai-decision and gemini-decision directly and as hybrid fallbacks', () => {
    const resolveSecretKey = (provider: 'anthropic' | 'openai' | 'gemini') =>
      provider === 'openai' ? 'sk-managed' : provider === 'gemini' ? 'gm-managed' : undefined;

    expect(
      resolveLiveJudgmentInvokePort({ preferred: 'openai-decision', resolveSecretKey })
    ).toMatchObject({
      provider: 'openai-decision',
      model: 'gpt-6-luna',
    });
    expect(
      resolveLiveJudgmentInvokePort({ preferred: 'gemini-decision', resolveSecretKey })
    ).toMatchObject({
      provider: 'gemini-decision',
      model: 'gemini-decision-1',
    });
    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'hybrid',
        hybridFallback: 'openai-decision',
        layaPythonBin: '/tmp/laya/bin/python',
        resolveSecretKey,
      })
    ).toMatchObject({
      provider: 'hybrid',
      model: expect.stringContaining('gpt-6-luna'),
    });
    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'hybrid',
        hybridFallback: 'gemini-decision',
        layaPythonBin: '/tmp/laya/bin/python',
        resolveSecretKey,
      })
    ).toMatchObject({
      provider: 'hybrid',
      model: expect.stringContaining('gemini-decision-1'),
    });
  });
});
