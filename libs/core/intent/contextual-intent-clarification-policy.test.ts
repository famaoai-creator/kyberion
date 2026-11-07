import { describe, expect, it } from 'vitest';
import { assessContextualClarification } from './contextual-intent-clarification-policy.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';

describe('contextual-intent-clarification-policy', () => {
  it('does not require clarification for a read-only agenda request when policy defaults cover it', () => {
    const frame = buildContextualIntentFrame('来週の予定教えて');
    const decision = assessContextualClarification({
      intentId: 'schedule-read-agenda',
      executionShape: 'direct_reply',
      requiredInputs: ['date_range', 'calendar_source'],
      confidence: 0.78,
      contextualFrame: frame,
    });

    expect(decision.shouldClarify).toBe(false);
    expect(decision.reason).toContain('agenda');
  });

  it('requires clarification for a project bootstrap request', () => {
    const decision = assessContextualClarification({
      intentId: 'bootstrap-project',
      executionShape: 'project_bootstrap',
      requiredInputs: ['project_brief'],
      confidence: 0.92,
    });

    expect(decision.shouldClarify).toBe(true);
    expect(decision.missingInputs).toContain('project_brief');
  });

  it('forces clarification for ambiguous schedule summary phrasing', () => {
    const decision = assessContextualClarification({
      intentId: 'schedule-read-agenda',
      text: '来月の予定をざっと確認して',
      executionShape: 'direct_reply',
      requiredInputs: [],
      confidence: 0.81,
    });

    expect(decision.shouldClarify).toBe(true);
    expect(decision.reason).toContain('ambiguity');
  });
});
