import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildExecutionFeedbackHints,
  loadExecutionFeedbackStore,
  parseExecutionFeedbackText,
  recordExecutionFeedback,
  resolveExecutionFeedbackPath,
  summarizeExecutionFeedback,
  validateExecutionFeedback,
} from './execution-feedback.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('execution feedback loop', () => {
  const feedbackPath = resolveExecutionFeedbackPath();
  let originalExists = false;
  let originalRaw: string | null = null;

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
});
