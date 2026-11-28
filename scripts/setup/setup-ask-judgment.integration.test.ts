import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ questions: [] as string[] }));
vi.mock('../../libs/core/foundation/json.js', async (load) => {
  const actual = await load<typeof import('../../libs/core/foundation/json.js')>();
  return {
    ...actual,
    readJsonIfPresent(file: string) {
      if (!file.endsWith('/judgment-calibration.json')) return actual.readJsonIfPresent(file);
      return {
        providers: {
          'laya-mlx': { questions: fixture.questions, temperature: 1, fitted_from: 'test fixture' },
        },
      };
    },
  };
});

import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentRequest,
} from '@agent/core/reasoning/judgment-backend';
import { assistWithJudgment } from '@agent/core/reasoning/judgment-assist';
import { resolveSetupAskGuidanceWithJudgment } from './setup-ask-judgment.js';

const conversation = 'setup.ask.conversation_destination';
const installation = 'setup.ask.onboarding_destination';
const recovery = 'setup.ask.recovery_destination';
const question = 'Kyberion を通してチーム内で会話するには？';

beforeEach(() => {
  resetJudgmentBackends();
  fixture.questions = [conversation, recovery, installation];
  vi.stubEnv('KYBERION_JUDGMENT_PROVIDERS', '');
  vi.stubEnv('KYBERION_JUDGMENT_ASSISTS', '');
});
afterEach(() => {
  resetJudgmentBackends();
  vi.unstubAllEnvs();
});

function registerLocal(answer: string, confidence = 0.95) {
  const handler = vi.fn(async (request: JudgmentRequest) =>
    request.questions.map(({ id }) => ({ id, value: answer, confidence, calibrated: false }))
  );
  registerJudgmentBackend({
    judgment_id: 'laya-mlx',
    egress: 'local-only',
    supports: () => true,
    judge: handler,
  });
  return handler;
}

describe('lifecycle guidance with the real judgment seam', () => {
  it('skips an earlier uncalibrated provider and keeps all choices', async () => {
    const uncalibrated = vi.fn(async () => []);
    registerJudgmentBackend({
      judgment_id: 'stub-uncalibrated',
      egress: 'external-api',
      supports: () => true,
      judge: uncalibrated,
    });
    const calibrated = registerLocal('channel');
    // This synthetic public call would otherwise select the earlier provider.
    const shared = await assistWithJudgment({
      baseline: '',
      state: 'synthetic labels',
      tier: 'public',
      requireCalibrated: true,
      questions: [{ kind: 'choice', id: conversation, options: ['channel'] }],
      accept: (answers) => String(answers[0]?.value),
    });
    expect(shared.value).toBe('channel');
    expect(shared.provider_id).toBe('laya-mlx');
    const result = await resolveSetupAskGuidanceWithJudgment(question);
    expect(result?.recommended?.domain).toBe('channel');
    expect(result?.clarification?.choices).toHaveLength(3);
    expect(result?.verification).toBe('not_run');
    expect(uncalibrated).not.toHaveBeenCalled();
    expect(calibrated.mock.lastCall?.[0].state).toBe('{"destination_hints":["team-chat"]}');
  });

  it('retains the baseline when a fitted provider fails and the alternatives are unfitted', async () => {
    const unfitted = vi.fn(async () => []);
    registerJudgmentBackend({
      judgment_id: 'stub-uncalibrated',
      egress: 'external-api',
      supports: () => true,
      judge: unfitted,
    });
    registerLocal('channel').mockRejectedValue(new Error('synthetic provider failure'));
    const result = await assistWithJudgment({
      baseline: 'none',
      state: 'synthetic labels',
      tier: 'public',
      requireCalibrated: true,
      questions: [{ kind: 'choice', id: conversation, options: ['channel'] }],
      accept: (answers) => String(answers[0]?.value),
    });
    expect(result.value).toBe('none');
    expect(unfitted).not.toHaveBeenCalled();
  });

  it('selects a recovery guide only from the offered choices', async () => {
    registerLocal('track');
    const result =
      await resolveSetupAskGuidanceWithJudgment('リリース工程を一時停止して安全に再開するには？');
    expect(result?.routes[0]?.id).toBe('recovery');
    expect(result?.clarification?.choices.map(({ domain }) => domain)).toEqual([
      'mission',
      'track',
      'surface',
    ]);
    expect(result?.recommended?.domain).toBe('track');
  });

  it.each([
    ['channel', 0.3],
    ['unclear', 0.95],
    ['not-a-guide', 0.95],
  ])('keeps the baseline when the answer is declined (%s)', async (answer, confidence) => {
    registerLocal(answer, confidence);
    const result = await resolveSetupAskGuidanceWithJudgment(question);
    expect(result?.recommended).toBeUndefined();
    expect(result?.clarification?.choices).toHaveLength(3);
  });

  it('rejects an offered route that lacks a hint in the current request', async () => {
    registerLocal('coordination');
    const result = await resolveSetupAskGuidanceWithJudgment(question, true);
    expect(result?.explanation?.decision).toBe('baseline_retained');
    expect(result?.recommended).toBeUndefined();
  });

  it('leaves conflicting destination hints for the operator to resolve', async () => {
    const backend = registerLocal('channel');
    const result = await resolveSetupAskGuidanceWithJudgment(
      'Kyberion を通してチーム内で別ホストの相棒と会話するには？',
      true
    );
    expect(result?.explanation?.decision).toBe('conflicting_hints');
    expect(result?.recommended).toBeUndefined();
    expect(result?.clarification?.choices).toHaveLength(3);
    expect(backend).not.toHaveBeenCalled();
  });

  it.each([
    'Kyberion を通してチーム内ではなく会話するには？',
    'How do I talk through Kyberion without team chat?',
  ])('does not treat a negated destination as a positive hint (%s)', async (text) => {
    const backend = registerLocal('channel');
    const result = await resolveSetupAskGuidanceWithJudgment(text, true);
    expect(result?.explanation?.decision).toBe('negated_request');
    expect(result?.recommended).toBeUndefined();
    expect(result?.clarification?.choices).toHaveLength(3);
    expect(backend).not.toHaveBeenCalled();
  });

  it('uses the same onboarding choice contract for Japanese and English prompts', async () => {
    const backend = registerLocal('installation');
    for (const text of [
      'ローカル環境の初期設定は何から始めればいいですか？',
      'Where should I start onboarding for local installation?',
    ]) {
      const result = await resolveSetupAskGuidanceWithJudgment(text);
      expect(result?.recommended?.domain).toBe('installation');
    }
    expect(backend.mock.calls).toHaveLength(2);
    expect(backend.mock.calls[0]![0].questions).toEqual(backend.mock.calls[1]![0].questions);
    expect(backend.mock.calls[0]![0].questions[0]?.id).toBe(installation);
  });

  it('avoids calls without a fit or when assists are disabled', async () => {
    const provider = registerLocal('channel');
    fixture.questions = [];
    expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
    vi.stubEnv('KYBERION_JUDGMENT_ASSISTS', 'off');
    expect((await resolveSetupAskGuidanceWithJudgment(question))?.recommended).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
  });

  it('preserves the choices when the provider times out', async () => {
    const provider = vi.fn((_request: JudgmentRequest) => new Promise<never>(() => undefined));
    registerJudgmentBackend({
      judgment_id: 'laya-mlx',
      egress: 'local-only',
      supports: () => true,
      judge: provider,
    });
    const result = await resolveSetupAskGuidanceWithJudgment(question);
    expect(provider.mock.lastCall?.[0].signal?.aborted).toBe(true);
    expect(result?.recommended).toBeUndefined();
    expect(result?.clarification?.choices).toHaveLength(3);
  });
});
