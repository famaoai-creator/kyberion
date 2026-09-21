import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_JUDGMENT_PROVIDER,
  judge,
  registerJudgmentBackend,
  resetJudgmentBackends,
  selectJudgmentBackend,
  type JudgmentQuestion,
} from './judgment-backend.js';
import {
  createLayaMlxBackend,
  LAYA_MLX_PROVIDER,
  type LayaWorker,
} from './laya-mlx-judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';

const QUESTION: JudgmentQuestion = {
  kind: 'choice',
  id: 'organization.work_shape',
  options: ['incident_response', 'routine_operation'],
  optionDescriptions: {
    incident_response: 'システム障害や緊急事態への対応',
    routine_operation: '月次や週次の定期的な業務',
  },
  instructions: 'どの種類の仕事にあたるか1つ選んでください。',
};

/** Stands in for the Python worker so no model is loaded in tests. */
function recordingWorker(reply: unknown) {
  const sent: unknown[] = [];
  let disposed = 0;
  const worker: LayaWorker = {
    async send(payload) {
      sent.push(payload);
      return reply as never;
    },
    dispose() {
      disposed += 1;
    },
  };
  return { worker, sent, disposed: () => disposed };
}

afterEach(() => {
  resetJudgmentBackends();
});

describe('laya-mlx judgment provider', () => {
  it('sends state and a question map with per-option descriptions', async () => {
    const { worker, sent } = recordingWorker({
      answers: {
        'organization.work_shape': {
          type: 'choice',
          choice: 'incident_response',
          probabilities: { incident_response: 0.9, routine_operation: 0.1 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 116, output_tokens: 0 },
    });
    const backend = createLayaMlxBackend({ spawnWorker: () => worker });

    const answers = await backend.judge({
      state: 'APIが落ちてます緊急で見てほしい',
      questions: [QUESTION],
      tier: 'personal',
    });

    const payload = sent[0] as any;
    expect(payload.state).toBe('APIが落ちてます緊急で見てほしい');
    expect(payload.questions['organization.work_shape'].type).toBe('choice');
    // The measured difference between 1/6 and 6/6 on this model.
    expect(payload.questions['organization.work_shape'].criteria).toEqual({
      incident_response: 'システム障害や緊急事態への対応',
      routine_operation: '月次や週次の定期的な業務',
    });
    expect(answers[0].value).toBe('incident_response');
    expect(answers[0].confidence).toBe(0.9);
    expect(answers[0].signals?.probabilities).toMatchObject({ incident_response: 0.9 });
  });

  it('falls back to option identifiers when no descriptions are given', async () => {
    const { worker, sent } = recordingWorker({
      answers: {
        'organization.work_shape': { type: 'choice', choice: 'routine_operation', confidence: 0.5 },
      },
    });
    const backend = createLayaMlxBackend({ spawnWorker: () => worker });
    await backend.judge({
      state: 'x',
      questions: [{ kind: 'choice', id: 'organization.work_shape', options: ['a', 'b'] }],
      tier: 'personal',
    });
    expect((sent[0] as any).questions['organization.work_shape'].criteria).toEqual({
      a: 'a',
      b: 'b',
    });
  });

  it('maps a bool question to a noul and derives confidence from the margin', async () => {
    const { worker } = recordingWorker({ answers: { done: { type: 'noul', noul: 0.12 } } });
    const backend = createLayaMlxBackend({ spawnWorker: () => worker });
    const answers = await backend.judge({
      state: 'two items still open',
      questions: [{ kind: 'bool', id: 'done', instructions: 'Is the work complete?' }],
      tier: 'personal',
    });
    expect(answers[0].value).toBe(false);
    expect(answers[0].confidence).toBeCloseTo(0.88, 5);
  });

  it('is reachable for personal-tier material, unlike the external providers', () => {
    registerOrganizationWorkJudgment();
    const { worker } = recordingWorker({ answers: {} });
    registerJudgmentBackend(createLayaMlxBackend({ spawnWorker: () => worker }));

    const selection = selectJudgmentBackend({
      state: '個人メモ',
      questions: [QUESTION],
      tier: 'personal',
    });
    expect(selection.backend.judgment_id).toBe(LAYA_MLX_PROVIDER);
  });

  it('reports calibrated false until a fit exists, despite being deterministic', async () => {
    registerOrganizationWorkJudgment();
    const { worker } = recordingWorker({
      answers: {
        'organization.work_shape': {
          type: 'choice',
          choice: 'incident_response',
          confidence: 0.999,
        },
      },
    });
    registerJudgmentBackend(createLayaMlxBackend({ spawnWorker: () => worker }));

    const result = await judge({ state: 'x', questions: [QUESTION], tier: 'personal' });
    expect(result.provider_id).toBe(LAYA_MLX_PROVIDER);
    // Determinism makes a fit *possible*; it is not itself a fit.
    expect(result.answers[0].calibrated).toBe(false);
  });

  it('discards a failed worker and degrades to the rules', async () => {
    registerOrganizationWorkJudgment();
    const { worker, disposed } = recordingWorker({ error: 'worker exited with code 1' });
    registerJudgmentBackend(createLayaMlxBackend({ spawnWorker: () => worker }));

    const result = await judge({
      state: '本番障害を収束させる',
      questions: [QUESTION],
      tier: 'personal',
    });
    expect(result.provider_id).toBe(BUILTIN_JUDGMENT_PROVIDER);
    expect(result.reason).toMatch(/worker exited/);
    // A dead worker must not be reused by the next judgment.
    expect(disposed()).toBe(1);
  });

  it('fails loudly when the worker omits a requested answer', async () => {
    const { worker } = recordingWorker({ answers: {} });
    const backend = createLayaMlxBackend({ spawnWorker: () => worker });
    await expect(
      backend.judge({ state: 'x', questions: [QUESTION], tier: 'personal' })
    ).rejects.toThrow(/omitted an answer/);
  });
});
