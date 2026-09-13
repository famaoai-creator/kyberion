import { describe, expect, it } from 'vitest';
import {
  applyHearingTurn,
  createHearingRecord,
  hearingCoverage,
  WEB_APP_HEARING_SCENARIO,
  type HearingScenario,
} from './hearing.js';

describe('hearing scenarios', () => {
  it('keeps the web-app scenario as the default', () => {
    const record = createHearingRecord('hearing-1', '2026-09-14T00:00:00.000Z');
    expect(record.scenario).toBe(WEB_APP_HEARING_SCENARIO.id);
    expect(record.requirements).toHaveLength(7);
    expect(hearingCoverage(record)).toEqual({ complete: 0, total: 7 });
  });

  it('accepts custom requirements and maps their aliases', () => {
    const scenario: HearingScenario = {
      id: 'event_plan',
      requirements: [
        { id: 'date', label: '開催日', aliases: ['when'] },
        { id: 'guests', label: '参加者', aliases: ['audience'] },
      ],
    };
    const record = createHearingRecord('hearing-2', '2026-09-14T00:00:00.000Z', scenario);
    const next = applyHearingTurn(
      record,
      {
        text: '社内メンバー向けです',
        request_id: 'turn-1',
        intent_resolution: {
          request_id: 'turn-1',
          normalized_intent: 'event_plan',
          missing_inputs: ['audience'],
          resolution_shape: 'project_bootstrap',
          outcome_kind: 'artifact',
          authority_level: 'human_clarification_required',
          next_action: { kind: 'provide_input', label: 'answer', consequence: 'continue' },
          rationale: 'guests are needed',
        },
      },
      '2026-09-14T00:01:00.000Z',
      scenario
    );
    expect(next.requirements.find((item) => item.id === 'guests')?.answer).toBe(
      '社内メンバー向けです'
    );
  });

  it('rejects invalid or duplicate scenario requirements', () => {
    expect(() =>
      createHearingRecord('hearing-3', '2026-09-14T00:00:00.000Z', {
        id: 'invalid',
        requirements: [
          { id: 'same', label: 'A' },
          { id: 'same', label: 'B' },
        ],
      })
    ).toThrow('HEARING_SCENARIO_INVALID');
  });
});
