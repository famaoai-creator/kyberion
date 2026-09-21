import { afterEach, describe, expect, it } from 'vitest';
import {
  judge,
  registerJudgmentBackend,
  resetJudgmentBackends,
  selectJudgmentBackend,
  type JudgmentQuestion,
} from './judgment-backend.js';
import {
  createTypeSafeJevBackend,
  TYPESAFE_JEV_PROVIDER,
} from './typesafe-jev-judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';

const QUESTION: JudgmentQuestion = {
  kind: 'choice',
  id: 'organization.work_shape',
  options: ['incident_response', 'routine_operation', 'governance_cadence'],
  instructions: 'Which kind of work is this request?',
};

/** Captures the outgoing call so the wire format can be asserted offline. */
function recordingFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

afterEach(() => {
  resetJudgmentBackends();
});

describe('typesafe-jev judgment provider', () => {
  it('sends state and a question map, and reads back choice/probabilities/confidence', async () => {
    const { impl, calls } = recordingFetch({
      model: 'jev-1.13.0',
      answers: {
        'organization.work_shape': {
          type: 'choice',
          choice: 'incident_response',
          probabilities: { incident_response: 0.91, routine_operation: 0.06 },
          confidence: 0.91,
        },
      },
      usage: { input_tokens: 40, output_tokens: 3 },
    });
    const backend = createTypeSafeJevBackend({ apiKey: 'test-key', fetchImpl: impl });

    const answers = await backend.judge({
      state: '本番障害を収束させる',
      questions: [QUESTION],
      tier: 'public',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].init.headers.authorization).toBe('Bearer test-key');
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.state).toBe('本番障害を収束させる');
    expect(sent.model).toBe('jev-latest');
    expect(sent.questions['organization.work_shape']).toMatchObject({
      type: 'choice',
      instructions: 'Which kind of work is this request?',
    });
    expect(Object.keys(sent.questions['organization.work_shape'].criteria)).toEqual(
      QUESTION.kind === 'choice' ? [...QUESTION.options] : []
    );

    expect(answers[0].value).toBe('incident_response');
    expect(answers[0].confidence).toBe(0.91);
    expect(answers[0].signals?.probabilities).toMatchObject({ incident_response: 0.91 });
  });

  it('maps a bool question to a noul and derives confidence from the margin', async () => {
    const { impl } = recordingFetch({
      answers: { done: { type: 'noul', noul: 0.12 } },
    });
    const backend = createTypeSafeJevBackend({ apiKey: 'test-key', fetchImpl: impl });
    const answers = await backend.judge({
      state: 'the task board still lists two open items',
      questions: [{ kind: 'bool', id: 'done', instructions: 'Is the work complete?' }],
      tier: 'public',
    });
    expect(answers[0].value).toBe(false);
    // A noul is one probability; distance from 0.5 is the only confidence there is.
    expect(answers[0].confidence).toBeCloseTo(0.88, 5);
  });

  it('reports calibrated false even though the vendor calls its confidence calibrated', async () => {
    registerOrganizationWorkJudgment();
    const { impl } = recordingFetch({
      answers: {
        'organization.work_shape': {
          type: 'choice',
          choice: 'incident_response',
          probabilities: { incident_response: 0.99 },
          confidence: 0.99,
        },
      },
    });
    registerJudgmentBackend(createTypeSafeJevBackend({ apiKey: 'test-key', fetchImpl: impl }));

    const result = await judge({ state: 'x', questions: [QUESTION], tier: 'public' });
    expect(result.provider_id).toBe(TYPESAFE_JEV_PROVIDER);
    expect(result.answers[0].confidence).toBe(0.99);
    // No fitted entry in judgment-calibration.json yet, so the claim does not stand.
    expect(result.answers[0].calibrated).toBe(false);
  });

  it('is unreachable for personal-tier state', () => {
    registerOrganizationWorkJudgment();
    const { impl } = recordingFetch({ answers: {} });
    registerJudgmentBackend(createTypeSafeJevBackend({ apiKey: 'test-key', fetchImpl: impl }));

    const selection = selectJudgmentBackend({
      state: '個人メモ',
      questions: [QUESTION],
      tier: 'personal',
    });
    expect(selection.backend.judgment_id).not.toBe(TYPESAFE_JEV_PROVIDER);
    expect(selection.reason).toMatch(/typesafe-jev/);
  });

  it('is unreachable for confidential-tier state until a tenant approves it', () => {
    registerOrganizationWorkJudgment();
    const { impl } = recordingFetch({ answers: {} });
    registerJudgmentBackend(createTypeSafeJevBackend({ apiKey: 'test-key', fetchImpl: impl }));

    const selection = selectJudgmentBackend({
      state: '顧客の契約条件',
      questions: [QUESTION],
      tier: 'confidential',
    });
    expect(selection.backend.judgment_id).not.toBe(TYPESAFE_JEV_PROVIDER);
  });

  it('refuses to call without an API key', async () => {
    const { impl, calls } = recordingFetch({ answers: {} });
    const backend = createTypeSafeJevBackend({ apiKey: '', fetchImpl: impl });
    await expect(
      backend.judge({ state: 'x', questions: [QUESTION], tier: 'public' })
    ).rejects.toThrow(/KYBERION_TYPESAFE_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces an API error instead of inventing an answer', async () => {
    const { impl } = recordingFetch({ error: 'unauthorized' }, 401);
    const backend = createTypeSafeJevBackend({ apiKey: 'bad', fetchImpl: impl });
    await expect(
      backend.judge({ state: 'x', questions: [QUESTION], tier: 'public' })
    ).rejects.toThrow(/401/);
  });

  it('fails loudly when the response omits a requested answer', async () => {
    const { impl } = recordingFetch({ answers: {} });
    const backend = createTypeSafeJevBackend({ apiKey: 'test-key', fetchImpl: impl });
    await expect(
      backend.judge({ state: 'x', questions: [QUESTION], tier: 'public' })
    ).rejects.toThrow(/omitted an answer/);
  });
});
