import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAnthropicJudgmentInvokePort,
  createGeminiJudgmentInvokePort,
  createHybridSemanticJudgmentInvokePort,
  createLayaMlxJudgmentInvokePort,
  createOpenAiCompatibleJudgmentInvokePort,
  evaluateLiveDotProposalJudgment,
  evaluateLiveSemanticJudgment,
  liveSemanticJudgmentModelConfigHash,
  resolveLiveJudgmentInvokePort,
  type HybridJudgmentRouteEvent,
  type LiveJudgmentInvokePort,
} from './semantic-judgment-live-provider.js';
import {
  createJudgmentLatencyFixture,
  resolveSyntheticLatencyProposal,
  SYNTHETIC_LATENCY_OPERATIONS,
} from './judgment-latency-fixture.js';
import { createJudgmentPrecedentSnapshot } from './judgment-precedents.js';
import { buildJudgmentModelInput, judgmentModelInputHashes } from './judgment-validation.js';
import { clearProviderHealth } from '../provider/provider-health-registry.js';

afterEach(() => {
  vi.unstubAllEnvs();
  clearProviderHealth();
});

function buildLiveLatencyFixture(
  operation: (typeof SYNTHETIC_LATENCY_OPERATIONS)[number],
  model: string,
  provider: string
) {
  const fixed = createJudgmentLatencyFixture();
  const precedent = createJudgmentPrecedentSnapshot(
    {
      scope: fixed.scope,
      selected_case_ids: [fixed.decision.case_id],
      allowed_case_ids: [fixed.decision.case_id],
    },
    {
      resolveCaseBinding: () => ({ case_id: fixed.decision.case_id, scope: fixed.scope }),
      readLedger: () => [fixed.decision],
      resolveGoals: () => [fixed.goal_binding],
    }
  );
  if (precedent.status !== 'ready') throw new Error('Invalid fixture precedent');
  const snapshot = precedent.snapshot;
  const proposal = resolveSyntheticLatencyProposal(operation);
  if (proposal.status !== 'ready') throw new Error('Invalid fixture proposal');
  const modelInput = buildJudgmentModelInput(snapshot, proposal.facts, [
    { evidence_key: 'trusted-observation', text: JSON.stringify(fixed.trusted_observation) },
    { evidence_key: 'untrusted-report', text: fixed.untrusted_report.text },
  ]);
  const config = { provider, model, maxOutputTokens: 512 };
  const binding = {
    schema_version: '1' as const,
    work_ref: 'live-test-work',
    work_revision: '1',
    trigger_key: 'live-eval',
    scope_hash: snapshot.scope_hash,
    ...judgmentModelInputHashes(modelInput),
    precedent_snapshot_hash: snapshot.snapshot_hash,
    policy_version: 'live-test-v1',
    rubric_version: 'semantic-judgment-mvp-v1',
    evaluator_version: 'live-v1',
    model_config_hash: liveSemanticJudgmentModelConfigHash(config),
  };
  return { fixed, snapshot, modelInput, binding, config };
}

describe('semantic-judgment-live-provider', () => {
  it('invokes Anthropic with temperature=0, maxRetries=0, AbortSignal, and exact usage', async () => {
    let seenParams: Record<string, unknown> | undefined;
    let seenOptions: Record<string, unknown> | undefined;
    const mockClient = {
      messages: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          seenParams = params;
          seenOptions = options;
          return {
            content: [{ type: 'text', text: '{"disposition":"apply_precedent"}' }],
            usage: { input_tokens: 120, output_tokens: 35 },
          };
        },
      },
    } as never;

    const port = createAnthropicJudgmentInvokePort({
      model: 'claude-haiku-4-5-20251001',
      client: mockClient,
    });
    const controller = new AbortController();
    const res = await port.invoke({
      mode: 'live_api',
      prompt: 'judge this',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: controller.signal,
    });

    expect(res).toEqual({
      text: '{"disposition":"apply_precedent"}',
      usage: { input_tokens: 120, output_tokens: 35 },
    });
    expect(seenParams).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      temperature: 0,
      max_tokens: 256,
    });
    expect(seenOptions).toMatchObject({ maxRetries: 0, signal: controller.signal });

    let seenClaude5Params: Record<string, unknown> | undefined;
    const mockClaude5Client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          seenClaude5Params = params;
          return {
            content: [{ type: 'text', text: '{"disposition":"reframe"}' }],
            usage: { input_tokens: 100, output_tokens: 20 },
          };
        },
      },
    } as never;
    const claude5Port = createAnthropicJudgmentInvokePort({
      model: 'claude-haiku-5-5',
      client: mockClaude5Client,
    });
    await claude5Port.invoke({
      mode: 'live_api',
      prompt: 'judge this',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: controller.signal,
    });
    expect(seenClaude5Params).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 256,
      output_config: { effort: 'low' },
    });
    expect(seenClaude5Params).not.toHaveProperty('temperature');
  });

  it('invokes OpenAI-compatible local endpoint and rejects missing integer usage', async () => {
    const fetchOk: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 80, completion_tokens: 20 },
        }),
        { status: 200 }
      );
    const port = createOpenAiCompatibleJudgmentInvokePort({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      providerName: 'local',
      fetchImpl: fetchOk,
    });
    const res = await port.invoke({
      mode: 'live_api',
      prompt: 'test',
      provider: 'local',
      model: 'qwen2.5:7b',
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: new AbortController().signal,
    });
    expect(res.usage).toEqual({ input_tokens: 80, output_tokens: 20 });

    let capturedBody: Record<string, unknown> | undefined;
    const fetchOpenAi: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"disposition":"apply_precedent"}' } }],
          usage: { prompt_tokens: 70, completion_tokens: 15 },
        }),
        { status: 200 }
      );
    };
    const openAiJsonPort = createOpenAiCompatibleJudgmentInvokePort({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      providerName: 'openai',
      fetchImpl: fetchOpenAi,
    });
    await openAiJsonPort.invoke({
      mode: 'live_api',
      prompt: 'judge',
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: new AbortController().signal,
    });
    expect(capturedBody?.response_format).toEqual({ type: 'json_object' });

    const fetchMissingUsage: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    const badPort = createOpenAiCompatibleJudgmentInvokePort({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      providerName: 'local',
      fetchImpl: fetchMissingUsage,
    });
    await expect(
      badPort.invoke({
        mode: 'live_api',
        prompt: 'test',
        provider: 'local',
        model: 'qwen2.5:7b',
        temperature: 0,
        maxOutputTokens: 256,
        tokenAllowance: 1000,
        deadlineMs: Date.now() + 5000,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/integer token usage/);
  });

  it('invokes Gemini generateContent with x-goog-api-key, thinkingBudget=0, and exact usage', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> | undefined;
    let seenBody: Record<string, unknown> | undefined;
    const fetchGemini: typeof fetch = async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init?.headers as Record<string, string>;
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'internal reasoning', thought: true },
                  { text: '{"disposition":"apply_precedent"}' },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 25 },
        }),
        { status: 200 }
      );
    };
    const port = createGeminiJudgmentInvokePort({
      apiKey: 'gm-test-key',
      model: 'gemini-2.5-flash',
      fetchImpl: fetchGemini,
    });
    const res = await port.invoke({
      mode: 'live_api',
      prompt: 'judge',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: Date.now() + 5000,
      signal: new AbortController().signal,
    });
    expect(seenUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    );
    expect(seenHeaders?.['x-goog-api-key']).toBe('gm-test-key');
    expect(seenBody?.generationConfig).toEqual({
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(res).toEqual({
      text: '{"disposition":"apply_precedent"}',
      usage: { input_tokens: 150, output_tokens: 25 },
    });

    const badGemini = createGeminiJudgmentInvokePort({
      apiKey: 'gm-test-key',
      fetchImpl: async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), {
          status: 200,
        }),
    });
    await expect(
      badGemini.invoke({
        mode: 'live_api',
        prompt: 'test',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        temperature: 0,
        maxOutputTokens: 256,
        tokenAllowance: 1000,
        deadlineMs: Date.now() + 5000,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/integer token usage/);
  });

  it('resolves configured providers from env and returns null when unconfigured', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('KYBERION_GEMINI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('KYBERION_LOCAL_LLM_URL', '');
    vi.stubEnv('KYBERION_LOCAL_LLM_MODEL', '');
    vi.stubEnv('KYBERION_LAYA_PYTHON', '');
    expect(resolveLiveJudgmentInvokePort({ layaPythonBin: null })).toBeNull();
    expect(resolveLiveJudgmentInvokePort({ layaPythonBin: '/tmp/laya/bin/python' })).toMatchObject({
      mode: 'live_api',
      provider: 'laya-mlx',
    });
    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'laya-mlx',
        layaPythonBin: '/tmp/laya/bin/python',
      })
    ).toMatchObject({ mode: 'live_api', provider: 'laya-mlx' });
    const resolveSecretKey = (provider: 'anthropic' | 'openai' | 'gemini') =>
      provider === 'openai'
        ? 'sk-managed-test'
        : provider === 'gemini'
          ? 'gm-managed-test'
          : undefined;
    expect(resolveLiveJudgmentInvokePort({ preferred: 'openai', resolveSecretKey })).toMatchObject({
      mode: 'live_api',
      provider: 'openai',
    });
    expect(resolveLiveJudgmentInvokePort({ preferred: 'gemini', resolveSecretKey })).toMatchObject({
      mode: 'live_api',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    });
    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'hybrid',
        hybridFallback: 'gemini',
        layaPythonBin: '/tmp/laya/bin/python',
        resolveSecretKey,
      })
    ).toMatchObject({
      mode: 'live_api',
      provider: 'hybrid',
      model: expect.stringContaining('gemini-2.5-flash'),
    });

    vi.stubEnv('KYBERION_LOCAL_LLM_URL', 'http://127.0.0.1:11434/v1');
    vi.stubEnv('KYBERION_LOCAL_LLM_MODEL', 'llama3.2');
    const localPort = resolveLiveJudgmentInvokePort();
    expect(localPort).toMatchObject({ mode: 'live_api', provider: 'local', model: 'llama3.2' });

    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const openaiPort = resolveLiveJudgmentInvokePort({ preferred: 'openai' });
    expect(openaiPort).toMatchObject({ mode: 'live_api', provider: 'openai' });

    // auto prioritizes Decision Models (gemini-decision -> openai-decision) when keys are available
    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'auto',
        resolveSecretKey: (provider) =>
          provider === 'openai' ? 'sk-managed' : provider === 'gemini' ? 'gm-managed' : undefined,
      })
    ).toMatchObject({ provider: 'gemini-decision', model: 'gemini-decision-1' });

    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'auto',
        resolveSecretKey: (provider) => (provider === 'openai' ? 'sk-managed' : undefined),
      })
    ).toMatchObject({ provider: 'openai-decision', model: 'gpt-6-luna' });

    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'hybrid',
        layaPythonBin: '/tmp/laya/bin/python',
        resolveSecretKey: (provider) =>
          provider === 'openai' ? 'sk-managed' : provider === 'gemini' ? 'gm-managed' : undefined,
      })
    ).toMatchObject({
      provider: 'hybrid',
      model: expect.stringContaining('gemini-decision-1'),
    });
  });

  it('evaluates latency_goal_v1 via live port and fails closed on deadline, budget, and forged citations', async () => {
    const f = buildLiveLatencyFixture('repair_fixture', 'claude-haiku-4-5-20251001', 'anthropic');
    const sourceKey = f.snapshot.evidence_refs[0].source_key;
    const now = Date.parse(f.fixed.now);

    const goodPort: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: f.config.provider,
      model: f.config.model,
      async invoke() {
        return {
          text: JSON.stringify({
            disposition: 'apply_precedent',
            precedent_keys: [sourceKey],
            rationale: 'Preserves 100 users, p95 <= 500ms, and 0 JPY cost.',
            applicability: ['isolated_fixture_only'],
          }),
          usage: { input_tokens: 200, output_tokens: 45 },
        };
      },
    };
    const ok = await evaluateLiveSemanticJudgment(
      {
        mode: 'live_api',
        binding: f.binding,
        scope: f.fixed.scope,
        modelInput: f.modelInput,
        snapshot: f.snapshot,
        requiredGoalKeys: f.snapshot.goals.map((g) => g.goal_key),
        knownProposalKeys: [...SYNTHETIC_LATENCY_OPERATIONS],
        parentDeadlineMs: now + 10_000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 512,
      },
      {
        port: goodPort,
        now: () => now,
        schedule: () => () => {},
        readCurrentContext: () => ({
          expectedBinding: f.binding,
          currentSnapshot: { status: 'ready', snapshot: f.snapshot },
        }),
      }
    );
    expect(ok.assessment.status).toBe('evaluated');
    if (ok.assessment.status === 'evaluated') {
      expect(ok.assessment.verdict.disposition).toBe('apply_precedent');
    }
    expect(ok.usage.input_tokens).toBe(200);
    expect(ok.usage.output_tokens).toBe(45);

    // Forged citation fails closed as missing_evidence
    const forgedPort: LiveJudgmentInvokePort = {
      ...goodPort,
      async invoke() {
        return {
          text: JSON.stringify({
            disposition: 'apply_precedent',
            precedent_keys: ['src-invented'],
            rationale: 'Forged.',
            applicability: ['none'],
          }),
          usage: { input_tokens: 100, output_tokens: 30 },
        };
      },
    };
    const forged = await evaluateLiveSemanticJudgment(
      {
        mode: 'live_api',
        binding: f.binding,
        scope: f.fixed.scope,
        modelInput: f.modelInput,
        snapshot: f.snapshot,
        requiredGoalKeys: f.snapshot.goals.map((g) => g.goal_key),
        knownProposalKeys: [...SYNTHETIC_LATENCY_OPERATIONS],
        parentDeadlineMs: now + 10_000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 512,
      },
      {
        port: forgedPort,
        now: () => now,
        schedule: () => () => {},
        readCurrentContext: () => ({
          expectedBinding: f.binding,
          currentSnapshot: { status: 'ready', snapshot: f.snapshot },
        }),
      }
    );
    expect(forged.assessment).toMatchObject({ status: 'unavailable', reason: 'missing_evidence' });
  });

  it('evaluates dot_proposal_v1 and rejects unknown precedent_refs or aborted calls', async () => {
    const now = Date.parse('2026-11-27T10:00:00.000Z');
    const port: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'local',
      model: 'test-model',
      async invoke() {
        return {
          text: JSON.stringify({
            disposition: 'apply_precedent',
            rationale: 'Matches prior approved cleanup.',
            precedent_refs: ['dact-prev-1'],
            risk_flags: [],
          }),
          usage: { input_tokens: 90, output_tokens: 25 },
        };
      },
    };

    const res = await evaluateLiveDotProposalJudgment(
      {
        input: {
          kind: 'dot_proposal_v1',
          dot_id: 'ops-dot',
          goal_statement: 'Keep runtime clean.',
          proposal: {
            action_id: 'dot_delegate_work',
            title: 'Rotate logs',
            objective: 'Clean stale temp logs',
            execution_shape: 'pipeline',
            pipeline_ref: 'pipelines/cleanup.json',
          },
          recent_feedback: ['- approved: "Rotate logs" (dot_delegate_work)'],
          signals: ['- OK disk_headroom'],
          precedents: [{ ref: 'dact-prev-1', summary: 'Prior approved cleanup' }],
        },
        parentDeadlineMs: now + 5000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 512,
      },
      { port, now: () => now, schedule: () => () => {} }
    );
    expect(res.assessment).toMatchObject({
      status: 'evaluated',
      provider: 'local',
      model: 'test-model',
      verdict: { disposition: 'apply_precedent', precedent_refs: ['dact-prev-1'] },
    });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await evaluateLiveDotProposalJudgment(
      {
        input: {
          kind: 'dot_proposal_v1',
          dot_id: 'ops-dot',
          goal_statement: 'Keep runtime clean.',
          proposal: {
            action_id: 'dot_delegate_work',
            title: 'Rotate logs',
            objective: 'Clean stale temp logs',
            execution_shape: 'pipeline',
          },
          recent_feedback: [],
          signals: [],
          precedents: [],
        },
        parentDeadlineMs: now + 5000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 512,
        signal: controller.signal,
      },
      { port, now: () => now, schedule: () => () => {} }
    );
    expect(cancelled.assessment).toMatchObject({ status: 'unavailable', reason: 'cancelled' });
  });

  it('evaluates latency_goal_v1 and dot_proposal_v1 through Laya-MLX port with warmup and dispose', async () => {
    const f = buildLiveLatencyFixture(
      'repair_fixture',
      'aac6fef/laya-multilingual-mlx',
      'laya-mlx'
    );
    const now = Date.parse(f.fixed.now);
    let disposed = 0;
    const judgeCalls: string[] = [];
    const judgeStates: string[] = [];
    const mockBackend = {
      judgment_id: 'laya-mlx',
      async judge(req: { state: string; questions: readonly { id: string }[] }) {
        judgeCalls.push(req.questions[0].id);
        judgeStates.push(req.state);
        const answer = req.state.includes('add_paid_cache') ? 'escalate' : 'apply_precedent';
        return [
          {
            id: req.questions[0].id,
            value: answer,
            confidence: 0.94,
            calibrated: true,
            signals: { probabilities: { apply_precedent: 0.94, reframe: 0.03, escalate: 0.03 } },
          },
        ];
      },
      dispose() {
        disposed += 1;
      },
    };

    const port = createLayaMlxJudgmentInvokePort({ backend: mockBackend });
    await port.warmup?.();
    expect(judgeCalls).toEqual(['semantic_judgment.disposition']);

    const latencyRes = await evaluateLiveSemanticJudgment(
      {
        mode: 'live_api',
        binding: f.binding,
        scope: f.fixed.scope,
        modelInput: f.modelInput,
        snapshot: f.snapshot,
        requiredGoalKeys: f.snapshot.goals.map((g) => g.goal_key),
        knownProposalKeys: [...SYNTHETIC_LATENCY_OPERATIONS],
        parentDeadlineMs: now + 10_000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 512,
      },
      {
        port,
        now: () => now,
        schedule: () => () => {},
        readCurrentContext: () => ({
          expectedBinding: f.binding,
          currentSnapshot: { status: 'ready', snapshot: f.snapshot },
        }),
      }
    );
    expect(latencyRes.assessment).toMatchObject({
      status: 'evaluated',
      provider: 'laya-mlx',
      verdict: { disposition: 'apply_precedent' },
    });
    expect(latencyRes.meta).toMatchObject({ disposition: 'apply_precedent', confidence: 0.94 });
    const evaluatedState = judgeStates[1] ?? '';
    expect(evaluatedState).toContain('Report:');
    expect(evaluatedState).toContain('Goal: target_users=100');
    expect(evaluatedState).toContain('Proposal (repair_fixture)');
    expect(evaluatedState).not.toMatch(/[a-f0-9]{64}/u);

    const directInvoke = await port.invoke({
      mode: 'live_api',
      prompt:
        '<untrusted_data source="judgment evaluation data">{&quot;goals&quot;:[{&quot;goal_key&quot;:&quot;g1&quot;}],&quot;precedents&quot;:[{&quot;source_key&quot;:&quot;src-1&quot;}],&quot;proposal&quot;:{&quot;proposal_key&quot;:&quot;repair_fixture&quot;,&quot;requested_goal&quot;:{&quot;target_users&quot;:100,&quot;max_p95_ms&quot;:500},&quot;incremental_monthly_cost&quot;:0},&quot;evidence&quot;:[{&quot;evidence_key&quot;:&quot;untrusted-report&quot;,&quot;text&quot;:&quot;ok&quot;}]}</untrusted_data>',
      provider: 'laya-mlx',
      model: 'aac6fef/laya-multilingual-mlx',
      temperature: 0,
      maxOutputTokens: 256,
      tokenAllowance: 1000,
      deadlineMs: now + 5000,
      signal: new AbortController().signal,
    });
    expect(directInvoke.meta).toMatchObject({
      disposition: 'apply_precedent',
      confidence: 0.94,
    });

    const dotRes = await evaluateLiveDotProposalJudgment(
      {
        input: {
          kind: 'dot_proposal_v1',
          dot_id: 'ops-dot',
          goal_statement: 'Keep runtime clean.',
          proposal: {
            action_id: 'dot_delegate_work',
            title: 'Rotate logs',
            objective: 'Clean stale temp logs',
            execution_shape: 'pipeline',
          },
          recent_feedback: [],
          signals: [],
          precedents: [{ ref: 'dact-1', summary: 'Prior cleanup' }],
        },
        parentDeadlineMs: now + 5000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 512,
      },
      { port, now: () => now, schedule: () => () => {} }
    );
    expect(dotRes.assessment).toMatchObject({
      status: 'evaluated',
      provider: 'laya-mlx',
      verdict: { disposition: 'apply_precedent', precedent_refs: ['dact-1'] },
    });
    expect(dotRes.meta).toMatchObject({ disposition: 'apply_precedent', confidence: 0.94 });

    port.dispose?.();
    expect(disposed).toBe(1);
  });

  it('routes confident allowed cases locally and falls back cleanly in hybrid mode', async () => {
    const f = buildLiveLatencyFixture('repair_fixture', 'gpt-4o-mini', 'openai');
    const sourceKey = f.snapshot.evidence_refs[0].source_key;
    const goalKey = f.snapshot.goals[0].goal_key;
    const now = Date.parse(f.fixed.now);

    let primaryWarmups = 0;
    let fallbackWarmups = 0;
    let primaryDisposes = 0;
    let fallbackDisposes = 0;
    let fallbackCalls = 0;
    let primaryDisposition: 'apply_precedent' | 'reframe' | 'escalate' = 'apply_precedent';
    let primaryConfidence = 0.95;
    const routeEvents: HybridJudgmentRouteEvent[] = [];

    const primary: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'laya-mlx',
      model: 'aac6fef/laya-multilingual-mlx',
      async warmup() {
        primaryWarmups += 1;
      },
      dispose() {
        primaryDisposes += 1;
      },
      async invoke() {
        return {
          text: JSON.stringify({
            disposition: primaryDisposition,
            precedent_keys: [sourceKey],
            rationale: 'Primary decision.',
            applicability: ['isolated_fixture_only'],
          }),
          usage: { input_tokens: 0, output_tokens: 0 },
          meta: { disposition: primaryDisposition, confidence: primaryConfidence },
        };
      },
    };

    const fallback: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'openai',
      model: 'gpt-4o-mini',
      async warmup() {
        fallbackWarmups += 1;
      },
      dispose() {
        fallbackDisposes += 1;
      },
      async invoke(input) {
        fallbackCalls += 1;
        const isDot = input.prompt.includes('dot_proposal_v1');
        return {
          text: JSON.stringify(
            isDot
              ? {
                  disposition: 'escalate',
                  rationale: 'Fallback escalated dot risk.',
                  precedent_refs: [],
                  risk_flags: ['operator_review_required'],
                }
              : {
                  disposition: 'reframe',
                  violated_goal_keys: [goalKey],
                  rationale: 'Fallback reframed.',
                  revised_question: 'Restore 100 users?',
                  evidence_needed: [],
                }
          ),
          usage: { input_tokens: 140, output_tokens: 40 },
        };
      },
    };

    const hybrid = createHybridSemanticJudgmentInvokePort({
      primary,
      fallback,
      minPrimaryConfidence: 0.85,
      onRoute: (event) => routeEvents.push(event),
    });
    expect(hybrid.provider).toBe('hybrid');
    expect(hybrid.model.length).toBeLessThanOrEqual(128);

    await hybrid.warmup?.();
    expect(primaryWarmups).toBe(1);
    expect(fallbackWarmups).toBe(1);

    const hybridBinding = {
      ...f.binding,
      model_config_hash: liveSemanticJudgmentModelConfigHash({
        provider: hybrid.provider,
        model: hybrid.model,
        maxOutputTokens: 512,
      }),
    };

    // 1. Confident apply_precedent stays on primary without calling fallback.
    const primaryHit = await evaluateLiveSemanticJudgment(
      {
        mode: 'live_api',
        binding: hybridBinding,
        scope: f.fixed.scope,
        modelInput: f.modelInput,
        snapshot: f.snapshot,
        requiredGoalKeys: [goalKey],
        knownProposalKeys: [...SYNTHETIC_LATENCY_OPERATIONS],
        parentDeadlineMs: now + 10_000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 512,
      },
      {
        port: hybrid,
        now: () => now,
        schedule: () => () => {},
        readCurrentContext: () => ({
          expectedBinding: hybridBinding,
          currentSnapshot: { status: 'ready', snapshot: f.snapshot },
        }),
      }
    );
    expect(primaryHit.assessment).toMatchObject({
      status: 'evaluated',
      provider: 'hybrid',
      verdict: { disposition: 'apply_precedent' },
    });
    expect(primaryHit.meta).toMatchObject({
      route: 'primary',
      route_reason: 'primary_confident',
      confidence: 0.95,
    });
    expect(fallbackCalls).toBe(0);
    expect(routeEvents.at(-1)).toMatchObject({ route: 'primary', reason: 'primary_confident' });

    // 2. Low-confidence primary verdict escalates to fallback and records fallback tokens.
    primaryConfidence = 0.55;
    const lowConfInvoke = await hybrid.invoke({
      mode: 'live_api',
      prompt: '<untrusted_data source="judgment evaluation data">{}</untrusted_data>',
      provider: hybrid.provider,
      model: hybrid.model,
      temperature: 0,
      maxOutputTokens: 512,
      tokenAllowance: 1000,
      deadlineMs: now + 5000,
      signal: new AbortController().signal,
    });
    expect(fallbackCalls).toBe(1);
    expect(lowConfInvoke.usage).toEqual({ input_tokens: 140, output_tokens: 40 });
    expect(lowConfInvoke.meta).toMatchObject({ route: 'fallback', route_reason: 'low_confidence' });

    // 3. dot_proposal_v1 allows reframe on primary when confident, routes escalate to fallback.
    primaryConfidence = 0.92;
    primaryDisposition = 'reframe';
    const dotReframe = await hybrid.invoke({
      mode: 'live_api',
      prompt:
        '<untrusted_data source="dot proposal judgment data">{"kind":"dot_proposal_v1"}</untrusted_data>',
      provider: hybrid.provider,
      model: hybrid.model,
      temperature: 0,
      maxOutputTokens: 512,
      tokenAllowance: 1000,
      deadlineMs: now + 5000,
      signal: new AbortController().signal,
    });
    expect(fallbackCalls).toBe(1);
    expect(dotReframe.meta).toMatchObject({ route: 'primary', disposition: 'reframe' });

    primaryDisposition = 'escalate';
    const dotEscalate = await hybrid.invoke({
      mode: 'live_api',
      prompt:
        '<untrusted_data source="dot proposal judgment data">{"kind":"dot_proposal_v1"}</untrusted_data>',
      provider: hybrid.provider,
      model: hybrid.model,
      temperature: 0,
      maxOutputTokens: 512,
      tokenAllowance: 1000,
      deadlineMs: now + 5000,
      signal: new AbortController().signal,
    });
    expect(fallbackCalls).toBe(2);
    expect(dotEscalate.meta).toMatchObject({
      route: 'fallback',
      route_reason: 'disallowed_disposition',
    });

    // 4. resolveLiveJudgmentInvokePort({ preferred: 'hybrid' })
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('KYBERION_GEMINI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('KYBERION_LOCAL_LLM_URL', '');
    vi.stubEnv('KYBERION_LOCAL_LLM_MODEL', '');
    expect(
      resolveLiveJudgmentInvokePort({ preferred: 'hybrid', layaPythonBin: '/tmp/laya/py' })
    ).toBeNull();

    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    expect(
      resolveLiveJudgmentInvokePort({ preferred: 'hybrid', layaPythonBin: '/tmp/laya/py' })
    ).toMatchObject({
      mode: 'live_api',
      provider: 'hybrid',
      model: expect.stringContaining('gpt-6-luna'),
    });
    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'hybrid',
        hybridFallback: 'anthropic',
        layaPythonBin: '/tmp/laya/py',
      })
    ).toMatchObject({
      mode: 'live_api',
      provider: 'hybrid',
      model: expect.stringContaining('claude-haiku'),
    });
    expect(
      resolveLiveJudgmentInvokePort({
        preferred: 'hybrid',
        hybridFallback: 'openai',
        hybridMinConfidence: 0.5,
        layaPythonBin: '/tmp/laya/py',
      })
    ).toMatchObject({
      mode: 'live_api',
      provider: 'hybrid',
      model: expect.stringContaining('gpt-4o-mini'),
    });

    hybrid.dispose?.();
    expect(primaryDisposes).toBe(1);
    expect(fallbackDisposes).toBe(1);
  });
});
