import { describe, expect, it } from 'vitest';
import {
  applyHearingTurn,
  createHearingRecord,
  hearingCoverage,
  WEB_APP_HEARING_SCENARIO,
  type HearingScenario,
  nextHearingQuestion,
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
        { id: 'date', label_key: 'front_desk:hearing_req_event_date', aliases: ['when'] },
        { id: 'guests', label_key: 'front_desk:hearing_req_event_guests', aliases: ['audience'] },
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
          { id: 'same', label_key: 'front_desk:hearing_req_a' },
          { id: 'same', label_key: 'front_desk:hearing_req_b' },
        ],
      })
    ).toThrow('HEARING_SCENARIO_INVALID');
  });
});

describe('question → answer sequence (asked_id)', () => {
  it('lands the next answer on the requirement the companion asked about, then asks the next one', () => {
    const now = '2026-09-14T00:00:00.000Z';
    let record = createHearingRecord('sess-q', now);
    // the companion asked about `content` (not the first open slot)
    record = { ...record, asked_id: 'content' };
    record = applyHearingTurn(record, { text: '案件一覧と進捗', request_id: 't1' }, now);
    expect(record.requirements.find((r) => r.id === 'content')?.answer).toBe('案件一覧と進捗');
    expect(record.requirements.find((r) => r.id === 'audience')?.answer).toBeUndefined();
    // after the answer, the next open requirement becomes the asked one
    expect(record.asked_id).toBe('audience');
    expect(nextHearingQuestion(record)?.id).toBe('audience');
    // an intent-resolution hint still wins over asked_id
    record = applyHearingTurn(
      record,
      {
        text: '来月中に',
        request_id: 't2',
        intent_resolution: { missing_inputs: ['constraints'] } as never,
      },
      now
    );
    expect(record.requirements.find((r) => r.id === 'constraints')?.answer).toBe('来月中に');
    expect(record.asked_id).toBe('audience');
  });

  it('reports no next question once everything is answered', () => {
    const now = '2026-09-14T00:00:00.000Z';
    let record = createHearingRecord('sess-done', now);
    for (let i = 0; i < 7; i += 1) {
      record = applyHearingTurn(record, { text: `a${i}`, request_id: `t${i}` }, now);
    }
    expect(nextHearingQuestion(record)).toBeUndefined();
    expect(record.asked_id).toBe('success');
  });
});
