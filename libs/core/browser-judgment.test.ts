import { afterEach, describe, expect, it } from 'vitest';
import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentBackend,
} from './judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';
import {
  BROWSER_FAILURE_QUESTION,
  BROWSER_READY_QUESTION,
  browserFailureQuestion,
  classifyBrowserFailure,
  classifyBrowserFailureByRules,
  judgePageReadiness,
} from './browser-judgment.js';

function provider(value: unknown, confidence = 0.95): JudgmentBackend {
  return {
    judgment_id: 'laya-mlx',
    egress: 'local-only',
    supports: () => true,
    async judge(request) {
      return request.questions.map((question) => ({
        id: question.id,
        value: value as string,
        confidence,
        calibrated: false,
      }));
    },
  };
}

afterEach(() => {
  resetJudgmentBackends();
});

describe('classifyBrowserFailure', () => {
  it('lets the heuristics decide when they match', async () => {
    expect(classifyBrowserFailureByRules('HTTP 429 Too Many Requests')).toBe('rate_limited');
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('login_required'));
    const verdict = await classifyBrowserFailure('HTTP 429 Too Many Requests');
    expect(verdict.kind).toBe('rate_limited');
    expect(verdict.source).toBe('rules');
  });

  it('fills in only what the heuristics left unknown', async () => {
    const page = 'この機能をご利用いただくには、お手続きが必要です。';
    expect(classifyBrowserFailureByRules(page)).toBe('unknown');
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('login_required'));
    const verdict = await classifyBrowserFailure(page, { requireCalibrated: false });
    expect(verdict.kind).toBe('login_required');
    expect(verdict.source).toBe('judgment');
  });

  it('stays unknown with no provider, a weak answer, or an answer off the enum', async () => {
    const page = 'この機能をご利用いただくには、お手続きが必要です。';
    expect((await classifyBrowserFailure(page, { requireCalibrated: false })).kind).toBe('unknown');

    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('login_required', 0.3));
    expect((await classifyBrowserFailure(page, { requireCalibrated: false })).kind).toBe('unknown');

    resetJudgmentBackends();
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('something_else'));
    expect((await classifyBrowserFailure(page, { requireCalibrated: false })).kind).toBe('unknown');
  });

  it('never sends page content to an external provider by default', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider('login_required'),
      judgment_id: 'typesafe-jev',
      egress: 'external-api',
    });
    const verdict = await classifyBrowserFailure('お手続きが必要です');
    expect(verdict.kind).toBe('unknown');
  });

  it('stays unknown by default, because nothing is calibrated for this question', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider('login_required', 0.99));
    const verdict = await classifyBrowserFailure('お手続きが必要です');
    expect(verdict.kind).toBe('unknown');
    expect(verdict.reason).toMatch(/not calibrated/);
  });

  it('describes every offered failure kind', () => {
    const question = browserFailureQuestion();
    expect(question.id).toBe(BROWSER_FAILURE_QUESTION);
    if (question.kind !== 'choice') throw new Error('expected a choice');
    expect(question.options).not.toContain('unknown');
    for (const option of question.options) {
      expect(question.optionDescriptions?.[option], option).toBeTruthy();
    }
  });
});

describe('judgePageReadiness', () => {
  it('cannot turn a failed gate into a pass', async () => {
    registerOrganizationWorkJudgment();
    // A provider insisting the page is ready must not override the gate.
    registerJudgmentBackend(provider(true));
    const verdict = await judgePageReadiness('全部そろっています', false, '検索結果の一覧');
    expect(verdict.ready).toBe(false);
    expect(verdict.keepWaiting).toBe(true);
    expect(verdict.source).toBe('baseline');
  });

  it('can add "not ready" on top of a passed gate', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(false));
    const verdict = await judgePageReadiness('読み込み中...', true, '検索結果の一覧', { requireCalibrated: false });
    expect(verdict.ready).toBe(false);
    expect(verdict.keepWaiting).toBe(true);
    expect(verdict.source).toBe('judgment');
  });

  it('agrees with a passed gate when the page looks ready', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(true));
    const verdict = await judgePageReadiness('検索結果 120件', true, '検索結果の一覧');
    expect(verdict.ready).toBe(true);
    expect(verdict.keepWaiting).toBe(false);
  });

  it('trusts the gate when no provider exists or one fails', async () => {
    expect((await judgePageReadiness('x', true, 'y')).ready).toBe(true);

    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider(false),
      async judge() {
        throw new Error('worker exploded');
      },
    });
    expect((await judgePageReadiness('x', true, 'y')).ready).toBe(true);
  });

  it('refuses a screenshot when no provider can see one, leaving the gate intact', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(false));
    const verdict = await judgePageReadiness('読み込み中...', true, '一覧', {
      requireCalibrated: false,
      screenshotBase64: 'aGVsbG8=',
      screenshotMediaType: 'image/png',
    });
    // Not answered from the text as if the picture had been looked at.
    expect(verdict.ready).toBe(true);
    expect(verdict.source).toBe('baseline');
    expect(verdict.reason).toMatch(/no provider can see images/);
  });

  it('sends the screenshot to a provider that can see one', async () => {
    registerOrganizationWorkJudgment();
    let sawImage = false;
    registerJudgmentBackend({
      ...provider(false),
      judgment_id: 'laya-mlx',
      acceptsImages: true,
      async judge(request) {
        sawImage = typeof request.state !== 'string' && Boolean(request.state.imageBase64);
        return request.questions.map((question) => ({
          id: question.id,
          value: false,
          confidence: 0.95,
          calibrated: false,
        }));
      },
    });
    const verdict = await judgePageReadiness('読み込み中...', true, '一覧', {
      requireCalibrated: false,
      screenshotBase64: 'aGVsbG8=',
    });
    expect(sawImage).toBe(true);
    expect(verdict.ready).toBe(false);
  });

  it('asks its question under a stable id', async () => {
    registerOrganizationWorkJudgment();
    let askedId: string | undefined;
    registerJudgmentBackend({
      ...provider(false),
      async judge(request) {
        askedId = request.questions[0].id;
        return request.questions.map((question) => ({
          id: question.id,
          value: false,
          confidence: 0.95,
          calibrated: false,
        }));
      },
    });
    await judgePageReadiness('読み込み中', true, '一覧', { requireCalibrated: false });
    expect(askedId).toBe(BROWSER_READY_QUESTION);
  });
});
