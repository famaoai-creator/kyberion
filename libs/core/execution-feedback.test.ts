import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildExecutionFeedbackHints,
  loadExecutionFeedbackStore,
  materializeExecutionFeedbackCandidate,
  parseExecutionFeedbackText,
  recordExecutionFeedback,
  resolveExecutionFeedbackPath,
  summarizeExecutionFeedback,
  validateExecutionFeedback,
} from './execution-feedback.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { executionFeedbackScopeRoot } from './execution-feedback-candidates.js';
import { pathResolver } from './path-resolver.js';
import {
  getIntentPhraseMatcher,
  resetIntentPhraseLexiconCache,
} from './intent/intent-phrase-lexicon.js';

describe('execution feedback loop', () => {
  const feedbackPath = resolveExecutionFeedbackPath();
  let originalExists = false;
  let originalRaw: string | null = null;
  const createdCandidateIds = new Set<string>();

  beforeAll(() => {
    originalExists = safeExistsSync(feedbackPath);
    originalRaw = originalExists
      ? (safeReadFile(feedbackPath, { encoding: 'utf8' }) as string)
      : null;
  });

  beforeEach(() => {
    if (originalExists && originalRaw !== null) safeWriteFile(feedbackPath, originalRaw);
    else if (safeExistsSync(feedbackPath)) safeRmSync(feedbackPath);
  });

  afterAll(() => {
    if (originalExists && originalRaw !== null) safeWriteFile(feedbackPath, originalRaw);
    else if (safeExistsSync(feedbackPath)) safeRmSync(feedbackPath);
  });

  afterEach(() => {
    for (const candidateId of createdCandidateIds) {
      safeRmSync(pathResolver.shared(`runtime/distill-candidates/${candidateId}.json`), {
        force: true,
      });
    }
    createdCandidateIds.clear();
    safeRmSync(
      executionFeedbackScopeRoot({ tier: 'confidential', tenant_slug: 'synthetic-feedback-a' }),
      { recursive: true, force: true }
    );
    safeRmSync(
      executionFeedbackScopeRoot({
        tier: 'confidential',
        tenant_slug: 'synthetic-feedback-a',
        mission_id: 'MSN-SYNTHETIC-OTHER',
      }),
      { recursive: true, force: true }
    );
    safeRmSync(
      executionFeedbackScopeRoot({ tier: 'confidential', tenant_slug: 'synthetic-feedback-b' }),
      { recursive: true, force: true }
    );
  });

  it('records feedback and summarizes repeated corrections per scenario', () => {
    recordExecutionFeedback({
      scenario_id: 'use-case-schedule-read-agenda',
      intent_id: 'schedule-read-agenda',
      outcome: 'partially_satisfied',
      correction: '対象期間を確認してから取得してほしい',
      comment: '予定は取れたが期間が違った',
    });
    recordExecutionFeedback({
      scenario_id: 'use-case-schedule-read-agenda',
      intent_id: 'schedule-read-agenda',
      outcome: 'dissatisfied',
      correction: '対象期間を確認してから取得してほしい',
    });

    const summary = summarizeExecutionFeedback({
      scenarioId: 'use-case-schedule-read-agenda',
      intentId: 'schedule-read-agenda',
    });
    expect(summary).toMatchObject({
      sample_count: 2,
      outcome_counts: { satisfied: 0, partially_satisfied: 1, dissatisfied: 1 },
      improvement_status: 'candidate',
    });
    expect(summary.common_corrections).toEqual(['対象期間を確認してから取得してほしい']);
    expect(buildExecutionFeedbackHints(summary)).toEqual([
      'Prior user corrections for this scenario: 対象期間を確認してから取得してほしい',
      'Previous user feedback included dissatisfaction; confirm scope and success conditions before repeating the same handoff.',
    ]);
    expect(loadExecutionFeedbackStore().entries).toHaveLength(2);
    expect(validateExecutionFeedback(loadExecutionFeedbackStore())).toMatchObject({ valid: true });
  });

  it('parses the user-facing text fallback', () => {
    expect(
      parseExecutionFeedbackText('評価 use-case-schedule-read-agenda: 一部違う: 対象期間を確認して')
    ).toMatchObject({
      scenario_id: 'use-case-schedule-read-agenda',
      intent_id: 'schedule-read-agenda',
      outcome: 'partially_satisfied',
      correction: '対象期間を確認して',
    });
  });

  it('parses the English feedback prefix and rejects look-alikes', () => {
    expect(
      parseExecutionFeedbackText('feedback use-case-schedule-read-agenda: dissatisfied: wrong week')
    ).toMatchObject({
      scenario_id: 'use-case-schedule-read-agenda',
      outcome: 'dissatisfied',
      correction: 'wrong week',
    });
    expect(parseExecutionFeedbackText('Feedback use-case-a: satisfied')).toMatchObject({
      outcome: 'satisfied',
    });
    expect(parseExecutionFeedbackText('feedbacks use-case-a: satisfied')).toBeNull();
  });

  it('rejects an invalid existing feedback store instead of resetting it', () => {
    safeWriteFile(feedbackPath, '{"version":"1.0.0","entries":[{}]}\n');

    expect(() => loadExecutionFeedbackStore()).toThrow('Invalid catalog execution-feedback');
  });

  it('preserves the canonical tenant scope on feedback and its improvement candidate', () => {
    const scope = { tier: 'confidential' as const, tenant_slug: 'synthetic-feedback-a' };
    const feedback = recordExecutionFeedback({
      scenario_id: 'scope-preservation-synthetic',
      intent_id: 'scope-preservation-synthetic',
      outcome: 'dissatisfied',
      correction: 'Confirm the fictional deadline before the next run.',
      scope,
    });
    const result = materializeExecutionFeedbackCandidate({ feedback });
    if (result.candidate) createdCandidateIds.add(result.candidate.candidate_id);
    expect(feedback.scope).toEqual(scope);
    expect(result.candidate).toMatchObject({ tier: 'confidential', scope, status: 'proposed' });
  });

  it('does not merge tenant feedback, deeper scopes, or legacy unscoped feedback', () => {
    const a = { tier: 'confidential' as const, tenant_slug: 'synthetic-feedback-a' };
    const scopes = [
      undefined,
      a,
      { ...a, tenant_slug: 'synthetic-feedback-b' },
      { ...a, mission_id: 'MSN-SYNTHETIC-OTHER' },
    ];
    const candidates = scopes.map((scope, index) => {
      const feedback = recordExecutionFeedback({
        scenario_id: 'shared-synthetic-scenario',
        intent_id: 'shared-synthetic-intent',
        outcome: 'dissatisfied',
        correction: 'Fictional correction ' + index,
        scope,
      });
      const result = materializeExecutionFeedbackCandidate({ feedback });
      if (result.candidate) createdCandidateIds.add(result.candidate.candidate_id);
      expect(result.summary.sample_count).toBe(1);
      expect(result.summary.common_corrections).toEqual(['Fictional correction ' + index]);
      return result.candidate!;
    });
    expect(new Set(candidates.map((entry) => entry.candidate_id)).size).toBe(4);
    expect(candidates[0].scope).toBeUndefined();
    expect(loadExecutionFeedbackStore().entries.every((entry) => !entry.scope)).toBe(true);
    expect(resolveExecutionFeedbackPath(a)).not.toBe(resolveExecutionFeedbackPath());
  });

  it('rejects owner-only scoped storage instead of reading or evicting legacy data', () => {
    const before = safeExistsSync(feedbackPath)
      ? safeReadFile(feedbackPath, { encoding: 'utf8' })
      : null;
    for (const owner_nhi of ['user:synthetic-a', 'user:synthetic-b']) {
      expect(() =>
        recordExecutionFeedback({
          scenario_id: 'owner-only',
          intent_id: 'owner-only',
          outcome: 'dissatisfied',
          scope: { tier: 'personal', owner_nhi },
        })
      ).toThrow(/SCOPE_UNSUPPORTED/);
    }
    expect(
      safeExistsSync(feedbackPath) ? safeReadFile(feedbackPath, { encoding: 'utf8' }) : null
    ).toEqual(before);
  });

  it('does not drop unknown scope restrictions before storage', () => {
    expect(() =>
      recordExecutionFeedback({
        scenario_id: 'unknown-scope',
        intent_id: 'unknown-scope',
        outcome: 'dissatisfied',
        scope: {
          tier: 'confidential',
          tenant_slug: 'synthetic-feedback-a',
          future_restriction: 'synthetic-owner-only',
        } as never,
      })
    ).toThrow(/SCOPE_UNSUPPORTED/);
  });

  it('rejects incomplete confidential scope before recording feedback', () => {
    expect(() =>
      recordExecutionFeedback({
        scenario_id: 'scope-invalid',
        intent_id: 'scope-invalid',
        outcome: 'dissatisfied',
        scope: { tier: 'confidential' },
      })
    ).toThrow(/tenant_slug/);
  });

  it('materializes a non-positive result as a reviewable procedure candidate', () => {
    const feedback = recordExecutionFeedback({
      scenario_id: 'use-case-browser-invoice',
      intent_id: 'browser-invoice',
      outcome: 'dissatisfied',
      correction: '送信前に内容を確認したい',
      source: 'operator',
    });
    const result = materializeExecutionFeedbackCandidate({
      feedback,
      procedureId: 'invoice.submit',
    });
    if (result.candidate) createdCandidateIds.add(result.candidate.candidate_id);

    expect(result.summary.improvement_status).toBe('candidate');
    expect(result.candidate?.status).toBe('proposed');
    expect(result.candidate?.target_kind).toBe('procedure');
    expect(result.candidate?.metadata).toMatchObject({
      improvement_kind: 'execution_feedback',
      procedure_id: 'invoice.submit',
      review_required: true,
    });
  });
});

describe('execution feedback reply pattern caching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compiles the reply pattern once per lexicon matcher', () => {
    resetIntentPhraseLexiconCache();
    const matcher = getIntentPhraseMatcher();
    const source = vi.spyOn(matcher, 'source');
    for (let i = 0; i < 5; i += 1) {
      expect(
        parseExecutionFeedbackText('feedback use-case-schedule-read-agenda: satisfied')?.outcome
      ).toBe('satisfied');
    }
    const compiledCalls = source.mock.calls.length;
    expect(compiledCalls).toBeGreaterThan(0);
    parseExecutionFeedbackText('評価 use-case-schedule-read-agenda: 満足');
    expect(source.mock.calls.length).toBe(compiledCalls);
  });
});
