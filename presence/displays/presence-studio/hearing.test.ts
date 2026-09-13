import { describe, expect, it } from 'vitest';
import { applyHearingTurn, createHearingRecord, hearingCoverage } from './hearing.js';

describe('hearing record', () => {
  it('creates the seven web-app requirements empty', () => {
    const record = createHearingRecord('hearing-1', '2026-09-14T00:00:00.000Z');
    expect(record.requirements).toHaveLength(7);
    expect(hearingCoverage(record)).toEqual({ complete: 0, total: 7 });
  });

  it('maps an intent missing input to the matching requirement', () => {
    const record = createHearingRecord('hearing-1', '2026-09-14T00:00:00.000Z');
    const next = applyHearingTurn(
      record,
      {
        text: '小さなチームが毎朝使う画面です',
        request_id: 'turn-1',
        intent_resolution: {
          request_id: 'turn-1',
          normalized_intent: 'web_app_build',
          missing_inputs: ['audience'],
          resolution_shape: 'project_bootstrap',
          outcome_kind: 'artifact',
          authority_level: 'human_clarification_required',
          next_action: { kind: 'provide_input', label: 'answer', consequence: 'continue' },
          rationale: 'audience is needed',
        },
      },
      '2026-09-14T00:01:00.000Z'
    );
    expect(next.requirements.find((item) => item.id === 'audience')).toMatchObject({
      answer: '小さなチームが毎朝使う画面です',
      confidence: 0.5,
      source_turn: 'turn-1',
    });
  });

  it('does not invent an answer from an empty turn', () => {
    const record = createHearingRecord('hearing-1', '2026-09-14T00:00:00.000Z');
    expect(
      applyHearingTurn(record, { text: '  ', request_id: 'turn-1' }, '2026-09-14T00:01:00.000Z')
    ).toEqual({ ...record, updated_at: '2026-09-14T00:01:00.000Z' });
  });
});
