import { afterEach, describe, expect, it } from 'vitest';
import {
  applyCalibrationTemperature,
  BUILTIN_JUDGMENT_PROVIDER,
  judge,
  listJudgmentBackends,
  registerJudgmentBackend,
  resolveCalibrationTemperature,
  resetJudgmentBackends,
  selectJudgmentBackend,
  type JudgmentBackend,
  type JudgmentQuestion,
} from './judgment-backend.js';
import {
  classifyOrganizationWork,
  ORGANIZATION_WORK_SHAPE_QUESTION,
  registerOrganizationWorkJudgment,
} from './organization-operating-model-persistence.js';

const QUESTION: JudgmentQuestion = {
  kind: 'choice',
  id: ORGANIZATION_WORK_SHAPE_QUESTION,
  options: ['incident_response', 'routine_operation'],
};

function stubBackend(overrides: Partial<JudgmentBackend> = {}): JudgmentBackend {
  return {
    judgment_id: 'stub-external',
    egress: 'external-api',
    supports: () => true,
    async judge(request) {
      return request.questions.map((question) => ({
        id: question.id,
        value: 'incident_response',
        confidence: 0.99,
        // A provider claiming its own confidence is fitted; the seam must
        // overwrite this from the calibration registry.
        calibrated: true,
      }));
    },
    ...overrides,
  };
}

afterEach(() => {
  resetJudgmentBackends();
});

describe('judgment-backend seam', () => {
  it('prefers question-specific calibration temperatures over the legacy default', () => {
    const entry = {
      questions: ['error.category', 'task.model_tier'],
      fitted_from: 'test',
      fitted_at: '2026-09-21T00:00:00.000Z',
      temperature: 1.5,
      temperatures: { 'error.category': 2.25 },
    };
    expect(resolveCalibrationTemperature(entry, 'error.category')).toBe(2.25);
    expect(resolveCalibrationTemperature(entry, 'task.model_tier')).toBe(1.5);
    expect(resolveCalibrationTemperature(entry, 'unknown')).toBeUndefined();
  });

  it('applies fitted temperature scaling to confidence values', () => {
    expect(applyCalibrationTemperature(0.9, 2)).toBeLessThan(0.9);
    expect(applyCalibrationTemperature(0.9, 2)).toBeGreaterThan(0.5);
    expect(applyCalibrationTemperature(0.9, 0)).toBe(0.9);
  });

  it('registers the built-in rule provider and answers through it', async () => {
    registerOrganizationWorkJudgment();
    expect(listJudgmentBackends().map((b) => b.judgment_id)).toContain(BUILTIN_JUDGMENT_PROVIDER);

    const result = await judge({
      state: '本番障害を収束させる',
      questions: [QUESTION],
      tier: 'public',
    });
    expect(result.provider_id).toBe(BUILTIN_JUDGMENT_PROVIDER);
    expect(result.answers[0].value).toBe('incident_response');
    expect(result.answers[0].confidence).toBeGreaterThan(0.7);
  });

  it('never reports the built-in rule provider as calibrated', async () => {
    registerOrganizationWorkJudgment();
    const result = await judge({
      state: '月次レポートを作って',
      questions: [QUESTION],
      tier: 'public',
    });
    // Its confidence is a discounted table lookup, not a fitted estimate.
    expect(result.answers[0].calibrated).toBe(false);
  });

  it('overwrites a provider self-declared calibration', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(stubBackend());
    const result = await judge({
      state: 'なんでもいい',
      questions: [QUESTION],
      tier: 'public',
    });
    expect(result.provider_id).toBe('stub-external');
    // The provider said `calibrated: true`; without a fitted registry entry
    // the seam must report false.
    expect(result.answers[0].calibrated).toBe(false);
  });

  it('keeps personal-tier material away from an external provider', () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(stubBackend());
    const selection = selectJudgmentBackend({
      state: '個人メモ',
      questions: [QUESTION],
      tier: 'personal',
    });
    expect(selection.backend.judgment_id).toBe(BUILTIN_JUDGMENT_PROVIDER);
    expect(selection.reason).toMatch(/fell back/);
    expect(selection.reason).toMatch(/stub-external/);
  });

  it('allows an external provider for public-tier material', () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(stubBackend());
    const selection = selectJudgmentBackend({
      state: '公開資料',
      questions: [QUESTION],
      tier: 'public',
    });
    expect(selection.backend.judgment_id).toBe('stub-external');
  });

  it('skips a provider that cannot answer the question shape', () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(stubBackend({ supports: (q) => q.kind === 'score' }));
    const selection = selectJudgmentBackend({
      state: 'なんでもいい',
      questions: [QUESTION],
      tier: 'public',
    });
    expect(selection.backend.judgment_id).toBe(BUILTIN_JUDGMENT_PROVIDER);
    expect(selection.reason).toMatch(/cannot answer choice/);
  });

  it('degrades to the built-in provider when a provider throws', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(
      stubBackend({
        async judge() {
          throw new Error('provider exploded');
        },
      })
    );
    const result = await judge({
      state: '本番障害を収束させる',
      questions: [QUESTION],
      tier: 'public',
    });
    expect(result.provider_id).toBe(BUILTIN_JUDGMENT_PROVIDER);
    expect(result.reason).toMatch(/provider exploded/);
    expect(result.answers[0].value).toBe('incident_response');
  });

  it('degrades when a provider returns a value outside the question contract', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(
      stubBackend({
        async judge(request) {
          return request.questions.map((question) => ({
            id: question.id,
            value: 'not-an-option',
            confidence: 0.99,
            calibrated: false,
          }));
        },
      })
    );
    const result = await judge({
      state: 'なんでもいい',
      questions: [QUESTION],
      tier: 'public',
    });
    expect(result.provider_id).toBe(BUILTIN_JUDGMENT_PROVIDER);
    expect(result.answers[0].value).toBe('routine_operation');
  });

  it('clamps a provider confidence into 0..1', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(
      stubBackend({
        async judge(request) {
          return request.questions.map((question) => ({
            id: question.id,
            value: 'incident_response',
            confidence: 4.2,
            calibrated: false,
          }));
        },
      })
    );
    const result = await judge({
      state: 'なんでもいい',
      questions: [QUESTION],
      tier: 'public',
    });
    expect(result.answers[0].confidence).toBe(1);
  });

  it('keeps an image away from a provider that cannot see one', async () => {
    registerOrganizationWorkJudgment();
    // supports() is about the question; seeing pixels is about the request,
    // so a text-only provider must be filtered on the capability instead.
    registerJudgmentBackend(stubBackend({ judgment_id: 'text-only' }));
    await expect(
      judge({
        state: { text: '検索結果の一覧', imageBase64: 'aGVsbG8=', imageMediaType: 'image/png' },
        questions: [QUESTION],
        tier: 'public',
      })
    ).rejects.toThrow(/no provider can see images/);
  });

  it('routes an image to a provider that declares it can see one', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(stubBackend({ judgment_id: 'vision', acceptsImages: true }));
    const result = await judge({
      state: { imageBase64: 'aGVsbG8=', imageMediaType: 'image/png' },
      questions: [QUESTION],
      tier: 'public',
    });
    expect(result.provider_id).toBe('vision');
  });

  it('still routes a plain string to a text-only provider', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(stubBackend({ judgment_id: 'text-only' }));
    const result = await judge({ state: '本番障害', questions: [QUESTION], tier: 'public' });
    expect(result.provider_id).toBe('text-only');
  });

  it('rejects a provider that does not declare an egress label', () => {
    expect(() =>
      registerJudgmentBackend({
        ...stubBackend(),
        egress: 'anywhere' as JudgmentBackend['egress'],
      })
    ).toThrow(/egress/);
  });
});

/**
 * Regression guard for finding F-2 (mission JUDGMENT-SEAM-20260921):
 * confidence used to rise on exactly the utterances that most needed a
 * human, because keyword density is anti-correlated with clarity here.
 */
describe('organization work confidence separates clear from ambiguous', () => {
  const THRESHOLD = 0.7;

  it.each([
    ['APIが落ちてます緊急で見てほしい'],
    ['来期予算の決裁をお願いしたい'],
    ['月次レポートを作って'],
    ['顧客対応の窓口を整理したい'],
    ['新しい配信方法を試したい'],
    ['社内ポータルを新しく作る'],
    // Asserted elsewhere as auto-resolvable; kept here so a confidence change
    // that would flip them shows up in this file too.
    ['今月の運用レポートを作る'],
    ['本番障害を収束させる'],
    ['SLOを変更する承認を行う'],
  ])('resolves %s without asking', (utterance) => {
    expect(classifyOrganizationWork(utterance).confidence).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it.each([
    // Two nouns, no predicate: names a topic, does not request work.
    ['請求まわり'],
    // incident AND routine AND governance in one sentence.
    ['障害対応の月次レポートを作って承認をもらう'],
    ['あれどうなった'],
    ['ちょっと気になってることがあるんだけど'],
    ['今日はいい天気ですね'],
    ['コーヒー豆を買いたい'],
  ])('asks a human about %s', (utterance) => {
    expect(classifyOrganizationWork(utterance).confidence).toBeLessThan(THRESHOLD);
  });

  it('explains how a confidence was reached', () => {
    const result = classifyOrganizationWork('障害対応の月次レポートを作って承認をもらう');
    expect(result.signals).toMatchObject({ prior: 0.93, competition: 0.6 });
    expect(result.signals?.strong_shapes).toEqual(
      expect.arrayContaining(['incident_response', 'governance_cadence', 'routine_operation'])
    );
  });
});
