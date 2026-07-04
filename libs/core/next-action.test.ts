import { describe, expect, it } from 'vitest';

import { buildCompletionNextAction, formatCompletionNextAction } from './next-action.js';

describe('next-action completion path', () => {
  it('builds a structured completion summary for satisfied goals', () => {
    const action = buildCompletionNextAction({
      goal: {
        summary: 'Deliver the mission closeout note',
        success_condition: 'The closeout note is saved',
      },
      reconciliation: {
        satisfied: true,
        delivered: ['evidence/closeout.md'],
        gaps: [],
        confidence: 0.93,
        evidence_refs: ['evidence/closeout.md'],
      },
    });

    expect(action).toMatchObject({
      title: 'Completion confirmed',
      request: 'The closeout note is saved',
      satisfied: true,
      confidence: 0.93,
      delivered: ['evidence/closeout.md'],
      gaps: [],
      evidence_refs: ['evidence/closeout.md'],
    });
    expect(action.next_step).toContain('archival');

    const lines = formatCompletionNextAction(action);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Completion: Completion confirmed',
        'Goal: The closeout note is saved',
        'Satisfied: yes',
        'Confidence: 0.93',
        'Delivered: evidence/closeout.md',
        'Evidence: evidence/closeout.md',
      ])
    );
  });

  it('surfaces gaps when the goal is not yet satisfied', () => {
    const action = buildCompletionNextAction({
      goal: {
        summary: 'Deliver the mission closeout note',
        success_condition: 'The closeout note is saved',
      },
      reconciliation: {
        satisfied: false,
        delivered: [],
        gaps: ['No mission evidence refs were collected.'],
        confidence: 0.35,
      },
    });

    expect(action).toMatchObject({
      title: 'Completion requires follow-up',
      satisfied: false,
      confidence: 0.35,
      gaps: ['No mission evidence refs were collected.'],
    });
    expect(action.next_step).toContain('Resolve the gaps');
  });
});
