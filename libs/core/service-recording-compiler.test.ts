import { describe, expect, it } from 'vitest';
import { compileServiceRecording } from './service-recording-compiler.js';
import type { ServiceRecording } from './service-recording.js';

function rec(overrides: Partial<ServiceRecording> = {}): ServiceRecording {
  return {
    schema_version: 'service-recording.v1',
    recording_id: 'svc-1',
    source: 'service-capture',
    created_at: '2026-06-24T00:00:00.000Z',
    target: { name: 'Deal Intake', services: ['jira', 'slack'] },
    steps: [
      { step_id: 's1', service_id: 'jira', action: 'create_issue', summary: '起票', risk_class: 'high', params: { summary: '{{input.title}}' }, produces: 'issue_key' },
      { step_id: 's2', service_id: 'slack', action: 'post_message', summary: '通知', risk_class: 'high', params: { text: '{{channel.issue_key}}' }, consumes: ['issue_key'] },
    ],
    risk_summary: { requires_manual_review: true, approval_required_count: 2 },
    ...overrides,
  };
}

const OPTS = { intentPhrases: ['起票してSlack通知'] };

describe('compileServiceRecording', () => {
  it('produces a service-substrate ProcedureEntry', () => {
    const { procedureEntry } = compileServiceRecording(rec(), OPTS);
    expect(procedureEntry.substrate).toBe('service');
    expect(procedureEntry.adapter).toMatchObject({ recorder: 'service-capture', executor: 'service:preset' });
    expect(procedureEntry.target.services).toEqual(['jira', 'slack']);
  });

  it('derives risk_class=high when an external-effect step exists', () => {
    expect(compileServiceRecording(rec(), OPTS).procedureEntry.risk_class).toBe('high');
  });

  it('derives risk_class=low for an all-read recording and isReadOnly=true', () => {
    const readOnly = rec({
      steps: [{ step_id: 'r1', service_id: 'jira', action: 'search', summary: '検索', risk_class: 'read' }],
      risk_summary: { requires_manual_review: true, approval_required_count: 0 },
    });
    const result = compileServiceRecording(readOnly, OPTS);
    expect(result.procedureEntry.risk_class).toBe('low');
    expect(result.isReadOnly).toBe(true);
  });

  it('lifts {{input.*}} placeholders into required_inputs', () => {
    const { procedureEntry } = compileServiceRecording(rec(), OPTS);
    expect(procedureEntry.required_inputs?.map((i) => i.name)).toEqual(['title']);
  });

  it('emits golden success conditions from produced channels', () => {
    const { goldenScenario } = compileServiceRecording(rec(), OPTS);
    expect(goldenScenario.success_conditions[0]).toMatchObject({ kind: 'response_field' });
    expect(goldenScenario.procedure_id).toBe(compileServiceRecording(rec(), OPTS).procedureEntry.procedure_id);
  });

  it('stores recording_ref on the adapter when provided', () => {
    const { procedureEntry } = compileServiceRecording(rec(), { ...OPTS, recordingRef: 'active/shared/runtime/recordings/svc-1.json' });
    expect(procedureEntry.adapter.recording_ref).toBe('active/shared/runtime/recordings/svc-1.json');
  });
});
