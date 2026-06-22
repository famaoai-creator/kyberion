import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildBrowserExtensionPipelineCandidate,
  hashBrowserExtensionAction,
  preflightBrowserExtensionSession,
  validateBrowserExtensionRecording,
  validateBrowserExtensionReceipt,
} from './browser-extension-bridge.js';

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function recording(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'browser-recording.v1',
    recording_id: 'REC-1',
    source: 'chrome-extension',
    created_at: '2026-06-23T00:00:00.000Z',
    tab: {
      origin: 'https://example.com',
      origin_hash: sha256('https://example.com'),
      title: 'Example',
    },
    extension: { version: '0.1.0' },
    actions: [
      {
        action_id: 'step-1',
        op: 'click_ref',
        summary: 'Continue を選択',
        risk: 'low',
        captured_at: '2026-06-23T00:00:01.000Z',
        target: {
          ref: '@e1',
          role: 'button',
          name: 'Continue',
          snapshot_hash: sha256('snapshot-1'),
        },
      },
      {
        action_id: 'step-2',
        op: 'fill_ref',
        summary: '会社名を入力（値は保存しない）',
        risk: 'low',
        captured_at: '2026-06-23T00:00:02.000Z',
        target: {
          ref: '@e2',
          role: 'textbox',
          name: 'Company name',
          snapshot_hash: sha256('snapshot-1'),
        },
        variable: { name: 'company_name', classification: 'user_input' },
      },
    ],
    risk_summary: {
      requires_manual_review: true,
      sensitive_input_omitted: 0,
      approval_required_count: 0,
    },
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'browser-extension-session.v1',
    mission_id: 'MSN-1',
    pipeline_id: 'browser-candidate-1',
    tab_id: '42',
    origin: 'https://example.com',
    mode: 'record',
    recording_id: 'REC-1',
    requested_operations: ['click_ref', 'fill_ref'],
    ...overrides,
  };
}

describe('browser extension bridge contracts', () => {
  it('accepts redacted recordings and emits a review-only pipeline candidate', () => {
    const parsed = validateBrowserExtensionRecording(recording());
    expect(parsed.valid).toBe(true);
    expect(buildBrowserExtensionPipelineCandidate(parsed.value!).requires_manual_review).toBe(true);
  });

  it('rejects recorded input values and raw selectors', () => {
    const withValue = recording({
      actions: [{
        ...recording().actions[1],
        value: 'secret@example.com',
      }],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 0,
      },
    });
    const withSelector = recording({
      actions: [{
        ...recording().actions[0],
        selector: '#continue',
      }],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 0,
      },
    });

    expect(validateBrowserExtensionRecording(withValue).valid).toBe(false);
    expect(validateBrowserExtensionRecording(withSelector).valid).toBe(false);
  });

  it('requires a variable for every fill action', () => {
    const invalid = recording({
      actions: [{
        ...recording().actions[1],
        variable: undefined,
      }],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 0,
      },
    });
    expect(validateBrowserExtensionRecording(invalid).errors).toContain('action step-2 must use a variable instead of a recorded value');
  });

  it('requires review and binds session origin to the recording origin', () => {
    const result = preflightBrowserExtensionSession({
      recording: recording(),
      session: session({ origin: 'https://other.example' }),
    });
    expect(result.status).toBe('blocked');
    expect(result.errors).toContain('session origin must match recording origin');
  });

  it('requires explicit approval hashes for high-risk actions', () => {
    const highRiskAction = {
      ...recording().actions[0],
      action_id: 'purchase-1',
      op: 'purchase',
      summary: '購入を確定する',
      risk: 'high',
    };
    const highRiskRecording = recording({
      actions: [highRiskAction],
      risk_summary: {
        requires_manual_review: true,
        sensitive_input_omitted: 0,
        approval_required_count: 1,
      },
    });
    const actionHash = hashBrowserExtensionAction(highRiskAction as any);
    const review = preflightBrowserExtensionSession({
      recording: highRiskRecording,
      session: session({ requested_operations: ['purchase'] }),
    });
    const execute = preflightBrowserExtensionSession({
      recording: highRiskRecording,
      session: session({
        mode: 'execute',
        requested_operations: ['purchase'],
        lease: {
          lease_id: 'lease-1',
          issued_at: '2026-06-23T00:00:00.000Z',
          expires_at: '2026-06-24T00:00:00.000Z',
          approved_step_hashes: [actionHash],
        },
      }),
      now: new Date('2026-06-23T12:00:00.000Z'),
    });

    expect(review.status).toBe('approval_required');
    expect(execute.status).toBe('blocked');
    expect(execute.errors).toContain('extension execution is unavailable until the Native Messaging bridge is installed');
  });

  it('validates redacted execution receipts', () => {
    expect(validateBrowserExtensionReceipt({
      kind: 'browser-extension-receipt.v1',
      receipt_id: 'RCP-1',
      mission_id: 'MSN-1',
      pipeline_id: 'browser-candidate-1',
      recording_id: 'REC-1',
      tab_id: '42',
      origin: 'https://example.com',
      status: 'blocked',
      created_at: '2026-06-23T00:00:00.000Z',
    }).valid).toBe(true);
  });

  it('emits only approved actions after review is finalized', () => {
    const reviewed = recording({
      review: {
        status: 'approved',
        reviewed_at: '2026-06-23T00:01:00.000Z',
        decisions: [
          { action_id: 'step-1', status: 'approved' },
          { action_id: 'step-2', status: 'rejected', reason: '入力は手動で行う' },
        ],
      },
    });
    const candidate = buildBrowserExtensionPipelineCandidate(reviewed as any);

    expect(candidate.review_status).toBe('approved');
    expect(candidate.operations).toEqual(['click_ref']);
    expect(candidate.excluded_action_ids).toEqual(['step-2']);
  });

  it('requires an explicit option or toggle state for selection actions', () => {
    const selection = {
      ...recording().actions[0],
      action_id: 'step-select',
      op: 'select_ref',
      summary: '通知を有効にする',
    };
    const missingState = recording({ actions: [selection] });
    const withState = recording({
      actions: [{ ...selection, selection: { kind: 'toggle', checked: true } }],
    });

    expect(validateBrowserExtensionRecording(missingState).valid).toBe(false);
    expect(validateBrowserExtensionRecording(withState).valid).toBe(true);
  });
});
