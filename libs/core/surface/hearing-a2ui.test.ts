import { describe, expect, it } from 'vitest';
import { validateA2UIMessage } from '@agent/core/a2ui';
import { applyHearingTurn, createHearingRecord, type HearingRecord } from './hearing.js';
import {
  HEARING_A2UI_SURFACE_ID,
  buildHearingA2UI,
  type HearingA2UIInput,
} from './hearing-a2ui.js';

const NOW = '2026-09-15T00:00:00.000Z';

function phasedRecord(): HearingRecord {
  return createHearingRecord('sess-1', NOW, {
    id: 'web_app_build',
    requirements: [
      { id: 'audience', label_key: 'front_desk:hearing_req_audience', phase_id: 'purpose' },
      { id: 'problem', label_key: 'front_desk:hearing_req_problem', phase_id: 'purpose' },
      { id: 'core_flow', label_key: 'front_desk:hearing_req_core_flow', phase_id: 'shape' },
    ],
    phases: [
      {
        id: 'purpose',
        title_key: 'front_desk:hearing_phase_purpose',
        requirement_ids: ['audience', 'problem'],
      },
      { id: 'shape', title_key: 'front_desk:hearing_phase_shape', requirement_ids: ['core_flow'] },
    ],
  });
}

function input(record: HearingRecord, overrides: Partial<HearingA2UIInput> = {}): HearingA2UIInput {
  const answered = (id: string) => Boolean(record.requirements.find((r) => r.id === id)?.answer);
  return {
    record,
    sessionId: 'sess-1',
    labels: { audience: '対象となる人', problem: '解決したいこと', core_flow: '主な流れ' },
    phases: [
      {
        id: 'purpose',
        title: '目的',
        complete: ['audience', 'problem'].filter(answered).length,
        total: 2,
      },
      { id: 'shape', title: '中身', complete: answered('core_flow') ? 1 : 0, total: 1 },
    ],
    prompt: '目的について、次に「対象となる人」を教えてください。',
    nextRequirementId: 'audience',
    text: {
      title: 'ヒアリング',
      coverage: '0/3 項目が埋まっています',
      next_question: '次の質問',
      unanswered: 'まだ聞けていません',
      decide: '決める',
      handoff: '依頼として渡す',
      phases: '段階',
      recorded: '確定しました',
    },
    ...overrides,
  };
}

describe('buildHearingA2UI', () => {
  it('projects an open hearing into valid A2UI: hero, phases, next question, one section per phase, no actions yet', () => {
    const { messages, actions } = buildHearingA2UI(input(phasedRecord()));
    for (const message of messages) expect(() => validateA2UIMessage(message)).not.toThrow();
    expect(messages[0].createSurface?.surfaceId).toBe(HEARING_A2UI_SURFACE_ID);
    const components = messages[1].updateComponents?.components ?? [];
    expect(components.map((c) => c.type)).toEqual([
      'display:hero',
      'display:progress',
      'display:alert',
      'display:section',
      'display:section',
    ]);
    const alert = components.find((c) => c.id === 'hearing-next');
    expect(alert?.props.message).toContain('対象となる人');
    const purpose = components.find((c) => c.id === 'hearing-phase-purpose');
    expect(JSON.stringify(purpose?.props)).toContain('まだ聞けていません');
    expect(JSON.stringify(components)).not.toMatch(/front_desk:|hearing_req_/u);
    expect(actions).toEqual([]);
  });

  it('offers "decide" only when everything is answered, and "hand off" only after deciding', () => {
    let record = phasedRecord();
    for (const [i, text] of ['営業', '散らばる', '登録して振り返る'].entries()) {
      record = applyHearingTurn(record, { text, request_id: `t${i}` }, NOW);
    }
    const open = buildHearingA2UI(
      input(record, { nextRequirementId: undefined, prompt: 'すべて埋まりました' })
    );
    expect(open.actions.map((a) => a.operation_id)).toEqual(['presence.hearing.decide']);
    expect(open.actions[0]).toMatchObject({
      method: 'POST',
      path: '/api/hearing/sess-1/decide',
      refresh: true,
    });
    const buttons =
      open.messages[1].updateComponents?.components.filter((c) => c.type === 'button') ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.action).toEqual(open.actions[0]);

    const decided: HearingRecord = {
      ...record,
      decided_at: NOW,
      decided_by: { kind: 'human', id: 'user:owner', role: 'owner' },
    };
    const afterDecide = buildHearingA2UI(input(decided));
    expect(afterDecide.actions.map((a) => a.operation_id)).toEqual(['presence.hearing.handoff']);
    const decidedAlert = afterDecide.messages[1].updateComponents?.components.find(
      (c) => c.id === 'hearing-decided'
    );
    expect(decidedAlert?.props.severity).toBe('success');

    const handedOff = buildHearingA2UI(
      input(decided, {
        missionId: 'MSN-1',
        text: { ...input(decided).text, handed_off: '依頼 MSN-1 として渡しました' },
      })
    );
    expect(handedOff.actions).toEqual([]);
    expect(handedOff.messages[2].updateDataModel?.data.mission_id).toBe('MSN-1');
  });
});
