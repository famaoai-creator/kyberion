import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGeminiDecisionBackend,
  createOpenAiDecisionBackend,
  GEMINI_DECISION_PROVIDER,
  MAX_DECISION_INPUT_BYTES,
  OPENAI_DECISION_PROVIDER,
} from './decision-api-judgment-backend.js';
import { clearProviderHealth } from './provider-health-registry.js';
import { isProviderDemoted } from './provider-health-view.js';
import {
  judge,
  registerJudgmentBackend,
  resetJudgmentBackends,
  selectJudgmentBackend,
  type JudgmentQuestion,
} from '../reasoning/judgment-backend.js';

afterEach(() => {
  resetJudgmentBackends();
  clearProviderHealth();
});

const SAMPLE_QUESTIONS: readonly JudgmentQuestion[] = [
  {
    kind: 'choice',
    id: 'work.shape',
    options: ['incident_response', 'routine_operation'],
    optionDescriptions: {
      incident_response: 'Urgent production incident mitigation',
      routine_operation: 'Scheduled recurring business operation',
    },
    instructions: 'Classify the request shape.',
  },
  {
    kind: 'bool',
    id: 'work.actionable',
    instructions: 'Does this state an actionable request?',
  },
  {
    kind: 'score',
    id: 'work.urgency',
    range: [1, 5],
    instructions: 'Rate urgency from 1 to 5.',
  },
];

describe('decision-api-judgment-backend', () => {
  it('answers multi-question requests via gemini-decision with sanitized wire keys, framing, calibrated=false, and blocks personal tier', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};

    const backend = createGeminiDecisionBackend({
      apiKey: 'gm-test-key',
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            decisions: {
              work_shape: {
                selected_option: 'incident_response',
                confidence: 0.94,
                probabilities: { incident_response: 0.94, routine_operation: 0.06 },
              },
              work_actionable: {
                selected_option: 'true',
                confidence: 0.91,
              },
              work_urgency: {
                selected_option: '4',
                confidence: 0.87,
              },
            },
            usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 0 },
          }),
          { status: 200 }
        );
      },
    });

    registerJudgmentBackend(backend);
    expect(() =>
      selectJudgmentBackend({
        state: '本番障害でAPIが500を返している',
        questions: SAMPLE_QUESTIONS,
        tier: 'personal',
      })
    ).toThrow(/egress/i);

    const selection = selectJudgmentBackend({
      state: '本番障害でAPIが500を返している',
      questions: SAMPLE_QUESTIONS,
      tier: 'public',
    });
    expect(selection.backend.judgment_id).toBe(GEMINI_DECISION_PROVIDER);

    const result = await judge({
      state: '本番障害でAPIが500を返している',
      questions: SAMPLE_QUESTIONS,
      tier: 'public',
    });

    expect(seenUrl).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
    expect(seenHeaders['x-goog-api-key']).toBe('gm-test-key');
    expect(seenBody.model).toBe('gemini-decision-1');
    expect(String(seenBody.input)).toContain('<untrusted_data source="judgment state">');
    expect(String(seenBody.input)).toContain('本番障害でAPIが500を返している');
    const sentQuestionKeys = Object.keys((seenBody.questions ?? {}) as Record<string, unknown>);
    expect(sentQuestionKeys).toEqual(['work_shape', 'work_actionable', 'work_urgency']);
    for (const wireKey of sentQuestionKeys) {
      expect(wireKey).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    expect(result.provider_id).toBe(GEMINI_DECISION_PROVIDER);
    expect(result.answers).toEqual([
      expect.objectContaining({
        id: 'work.shape',
        value: 'incident_response',
        confidence: 0.94,
        calibrated: false,
      }),
      expect.objectContaining({
        id: 'work.actionable',
        value: true,
        confidence: 0.91,
        calibrated: false,
      }),
      expect.objectContaining({
        id: 'work.urgency',
        value: 4,
        confidence: 0.87,
        calibrated: false,
      }),
    ]);
  });

  it('answers multi-question requests via openai-decision (/v1/decisions schema) and blocks personal tier', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};

    const backend = createOpenAiDecisionBackend({
      apiKey: 'sk-test-key',
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'dec_test',
            object: 'decision',
            model: 'gpt-6-luna',
            answers: [
              {
                name: 'work.shape',
                type: 'choice',
                choice: 'routine_operation',
                confidence: 0.88,
                probabilities: { incident_response: 0.12, routine_operation: 0.88 },
              },
              {
                name: 'work.actionable',
                type: 'choice',
                choice: { value: 'true' },
                confidence: 0.95,
              },
            ],
            usage: { input_tokens: 72, output_tokens: 0 },
          }),
          { status: 200 }
        );
      },
    });

    registerJudgmentBackend(backend);
    expect(() =>
      selectJudgmentBackend({
        state: 'Run monthly billing reconciliation',
        questions: SAMPLE_QUESTIONS.slice(0, 2),
        tier: 'personal',
      })
    ).toThrow(/egress/i);

    const result = await judge({
      state: 'Run monthly billing reconciliation',
      questions: SAMPLE_QUESTIONS.slice(0, 2),
      tier: 'public',
    });

    expect(seenUrl).toBe('https://api.openai.com/v1/decisions');
    expect(seenHeaders.authorization).toBe('Bearer sk-test-key');
    expect(seenBody.model).toBe('gpt-6-luna');
    expect(String(seenBody.input)).toContain('<untrusted_data source="judgment state">');
    expect(seenBody.questions).toEqual([
      {
        type: 'choice',
        name: 'work.shape',
        instructions: expect.stringContaining('incident_response'),
        choices: [{ value: 'incident_response' }, { value: 'routine_operation' }],
      },
      {
        type: 'choice',
        name: 'work.actionable',
        instructions: expect.stringContaining('statement holds'),
        choices: [{ value: 'true' }, { value: 'false' }],
      },
    ]);
    expect(result.provider_id).toBe(OPENAI_DECISION_PROVIDER);
    expect(result.answers).toEqual([
      expect.objectContaining({
        id: 'work.shape',
        value: 'routine_operation',
        confidence: 0.88,
        calibrated: false,
      }),
      expect.objectContaining({
        id: 'work.actionable',
        value: true,
        confidence: 0.95,
        calibrated: false,
      }),
    ]);
  });

  it('truncates oversized inputs to 32KB and avoids wire-key collisions', async () => {
    let seenBody: Record<string, unknown> = {};
    const collidingQuestions: readonly JudgmentQuestion[] = [
      { kind: 'bool', id: 'a.b' },
      { kind: 'bool', id: 'a_b' },
      { kind: 'bool', id: 'a_b_1' },
    ];
    const backend = createGeminiDecisionBackend({
      apiKey: 'gm-test-key',
      fetchImpl: async (_url, init) => {
        seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const keys = Object.keys((seenBody.questions ?? {}) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            decisions: Object.fromEntries(
              keys.map((k) => [k, { selected_option: 'true', confidence: 0.9 }])
            ),
          }),
          { status: 200 }
        );
      },
    });

    const largeState = 'x'.repeat(MAX_DECISION_INPUT_BYTES + 4096);
    const answers = await backend.judge({
      state: largeState,
      questions: collidingQuestions,
      tier: 'public',
    });

    const wireKeys = Object.keys((seenBody.questions ?? {}) as Record<string, unknown>);
    expect(new Set(wireKeys).size).toBe(3);
    for (const k of wireKeys) expect(k).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(answers.map((a) => a.id)).toEqual(['a.b', 'a_b', 'a_b_1']);
    expect(String(seenBody.input)).toContain('[truncated]');
    expect(Buffer.byteLength(String(seenBody.input), 'utf8')).toBeLessThan(
      MAX_DECISION_INPUT_BYTES + 512
    );
  });

  it('caches managed keys, invalidates on 401 with secret redaction, and skips demotion on caller abort', async () => {
    let keyIndex = 0;
    const keys = ['sk-firstsecretvalue123', 'sk-rotatedsecretvalue999'];
    const resolveSecretKey = vi.fn(() => keys[Math.min(keyIndex, keys.length - 1)]);
    let callCount = 0;

    const openAi = createOpenAiDecisionBackend({
      resolveSecretKey,
      fetchImpl: async (_url, init) => {
        callCount += 1;
        const auth = (init?.headers as Record<string, string>)?.authorization;
        if (callCount === 3) {
          keyIndex = 1;
          return new Response(`Invalid token ${auth}`, { status: 401 });
        }
        return new Response(
          JSON.stringify({
            answers: [{ name: 'q1', choice: 'true', confidence: 0.95 }],
            usage: { input_tokens: 10, output_tokens: 0 },
          }),
          { status: 200 }
        );
      },
    });

    const req: Parameters<typeof openAi.judge>[0] = {
      state: 'check',
      questions: [{ kind: 'bool', id: 'q1' }],
      tier: 'public',
    };
    await openAi.judge(req);
    await openAi.judge(req);
    expect(resolveSecretKey).toHaveBeenCalledTimes(1); // cached across calls

    await expect(openAi.judge(req)).rejects.toThrow(/Bearer \[REDACTED\]/);
    await openAi.judge(req);
    expect(resolveSecretKey).toHaveBeenCalledTimes(2); // re-resolved after 401 invalidation

    clearProviderHealth();
    const ac = new AbortController();
    const geminiAbort = createGeminiDecisionBackend({
      apiKey: 'AIzaTestSecretKeyValue123456',
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    const pending = geminiAbort.judge({
      state: 'check',
      questions: [{ kind: 'bool', id: 'q1' }],
      tier: 'public',
      signal: ac.signal,
    });
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(isProviderDemoted(GEMINI_DECISION_PROVIDER)).toBe(false);
  });

  it('fails over from a failing/demoted decision provider to a healthy secondary provider in judge()', async () => {
    registerJudgmentBackend(
      createGeminiDecisionBackend({
        apiKey: 'gm-fail',
        fetchImpl: async () => new Response('upstream error', { status: 500 }),
      })
    );
    registerJudgmentBackend(
      createOpenAiDecisionBackend({
        apiKey: 'sk-ok',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              answers: [{ name: 'q1', choice: 'true', confidence: 0.97 }],
              usage: { input_tokens: 12, output_tokens: 0 },
            }),
            { status: 200 }
          ),
      })
    );

    const first = await judge({
      state: 'Transient outage',
      questions: [{ kind: 'bool', id: 'q1' }],
      tier: 'public',
    });
    expect(first.provider_id).toBe(OPENAI_DECISION_PROVIDER);
    expect(first.reason).toContain(`failed over to '${OPENAI_DECISION_PROVIDER}'`);
    expect(isProviderDemoted(GEMINI_DECISION_PROVIDER)).toBe(true);

    // Subsequent selection skips demoted gemini-decision directly
    const nextSelection = selectJudgmentBackend({
      state: 'Transient outage',
      questions: [{ kind: 'bool', id: 'q1' }],
      tier: 'public',
    });
    expect(nextSelection.backend.judgment_id).toBe(OPENAI_DECISION_PROVIDER);
  });
});
