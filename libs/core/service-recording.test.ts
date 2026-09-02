import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectServiceInputNames,
  isExternalEffectStep,
  loadServiceRecordingAtPath,
  validateServiceRecording,
  type ServiceRecording,
} from './service-recording.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const RECORDING_TEST_ROOT = pathResolver.sharedTmp('service-recording-loader-test');

function rec(overrides: Partial<ServiceRecording> = {}): ServiceRecording {
  return {
    schema_version: 'service-recording.v1',
    recording_id: 'svc-1',
    source: 'service-capture',
    created_at: '2026-06-24T00:00:00.000Z',
    target: { name: 'Deal Intake', services: ['jira', 'slack'] },
    steps: [
      {
        step_id: 's1',
        service_id: 'jira',
        action: 'create_issue',
        summary: '起票',
        risk_class: 'high',
        params: { summary: '{{input.title}}' },
        produces: 'issue_key',
      },
      {
        step_id: 's2',
        service_id: 'slack',
        action: 'post_message',
        summary: '通知',
        risk_class: 'high',
        params: { text: '{{channel.issue_key}}' },
        consumes: ['issue_key'],
      },
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
    const r = validateServiceRecording(
      rec({ risk_summary: { requires_manual_review: true, approval_required_count: 1 } })
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('approval_required_count');
  });

  it('rejects a step whose service is not in target.services', () => {
    const r = validateServiceRecording(
      rec({
        steps: [
          { step_id: 's1', service_id: 'box', action: 'upload', summary: 'x', risk_class: 'high' },
        ],
        risk_summary: { requires_manual_review: true, approval_required_count: 1 },
      })
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('not in target.services');
  });

  it('rejects consuming a channel before it is produced', () => {
    const r = validateServiceRecording(
      rec({
        steps: [
          {
            step_id: 's1',
            service_id: 'slack',
            action: 'post_message',
            summary: 'x',
            risk_class: 'high',
            consumes: ['issue_key'],
          },
        ],
        risk_summary: { requires_manual_review: true, approval_required_count: 1 },
      })
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('before it is produced');
  });

  it('rejects raw sensitive parameters', () => {
    const r = validateServiceRecording(
      rec({
        steps: [
          {
            step_id: 's1',
            service_id: 'jira',
            action: 'create_issue',
            summary: 'x',
            risk_class: 'high',
            params: { password: 'raw-secret' },
          },
        ],
        risk_summary: { requires_manual_review: true, approval_required_count: 1 },
      })
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('unbound sensitive parameter');
  });

  it('rejects an approved review with incomplete or unknown decisions', () => {
    const incomplete = validateServiceRecording(
      rec({
        review: {
          status: 'approved',
          decisions: [{ step_id: 's1', status: 'approved' }],
        },
      })
    );
    expect(incomplete.valid).toBe(false);
    expect(incomplete.errors.join(' ')).toContain('missing decisions for: s2');

    const unknown = validateServiceRecording(
      rec({
        review: {
          status: 'approved',
          decisions: [
            { step_id: 's1', status: 'approved' },
            { step_id: 's2', status: 'approved' },
            { step_id: 'unknown', status: 'approved' },
          ],
        },
      })
    );
    expect(unknown.valid).toBe(false);
    expect(unknown.errors.join(' ')).toContain('unknown step unknown');
  });
});

describe('isExternalEffectStep / collectServiceInputNames', () => {
  it('classifies high risk as external effect', () => {
    expect(isExternalEffectStep(rec().steps[0])).toBe(true);
    expect(
      isExternalEffectStep({
        step_id: 'r',
        service_id: 'jira',
        action: 'search',
        summary: 's',
        risk_class: 'read',
      })
    ).toBe(false);
  });

  it('collects distinct {{input.*}} placeholder names', () => {
    expect(collectServiceInputNames(rec())).toEqual(['title']);
  });
});

describe('loadServiceRecordingAtPath', () => {
  it('loads a persisted recording through the regular-file contract boundary', () => {
    safeRmSync(RECORDING_TEST_ROOT, { recursive: true, force: true });
    safeMkdir(RECORDING_TEST_ROOT, { recursive: true });
    const recordingPath = path.join(RECORDING_TEST_ROOT, 'recording.json');
    safeWriteFile(recordingPath, `${JSON.stringify(rec())}\n`);

    expect(loadServiceRecordingAtPath(recordingPath).recording_id).toBe('svc-1');
  });

  it('rejects a directory at the persisted recording path', () => {
    safeRmSync(RECORDING_TEST_ROOT, { recursive: true, force: true });
    safeMkdir(path.join(RECORDING_TEST_ROOT, 'recording.json'), { recursive: true });

    expect(() =>
      loadServiceRecordingAtPath(path.join(RECORDING_TEST_ROOT, 'recording.json'))
    ).toThrow('recording must be a regular file');
  });
});
