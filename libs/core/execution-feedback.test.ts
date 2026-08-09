import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { pathResolver } from './path-resolver.js';

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
