import { describe, expect, it } from 'vitest';
import {
  collectServiceInputNames,
  isExternalEffectStep,
  validateServiceRecording,
  type ServiceRecording,
} from './service-recording.js';

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

describe('validateServiceRecording', () => {
  it('accepts a valid recording', () => {
    expect(validateServiceRecording(rec()).valid).toBe(true);
  });

  it('rejects approval_required_count mismatch', () => {
    const r = validateServiceRecording(rec({ risk_summary: { requires_manual_review: true, approval_required_count: 1 } }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('approval_required_count');
  });

  it('rejects a step whose service is not in target.services', () => {
    const r = validateServiceRecording(rec({
      steps: [{ step_id: 's1', service_id: 'box', action: 'upload', summary: 'x', risk_class: 'high' }],
      risk_summary: { requires_manual_review: true, approval_required_count: 1 },
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('not in target.services');
  });

  it('rejects consuming a channel before it is produced', () => {
    const r = validateServiceRecording(rec({
      steps: [
        { step_id: 's1', service_id: 'slack', action: 'post_message', summary: 'x', risk_class: 'high', consumes: ['issue_key'] },
      ],
      risk_summary: { requires_manual_review: true, approval_required_count: 1 },
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('before it is produced');
  });
});

describe('isExternalEffectStep / collectServiceInputNames', () => {
  it('classifies high risk as external effect', () => {
    expect(isExternalEffectStep(rec().steps[0])).toBe(true);
    expect(isExternalEffectStep({ step_id: 'r', service_id: 'jira', action: 'search', summary: 's', risk_class: 'read' })).toBe(false);
  });

  it('collects distinct {{input.*}} placeholder names', () => {
    expect(collectServiceInputNames(rec())).toEqual(['title']);
  });
});
