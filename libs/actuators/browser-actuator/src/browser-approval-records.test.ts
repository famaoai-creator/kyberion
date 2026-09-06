import { describe, expect, it } from 'vitest';
import {
  completeBrowserOperatorApproval,
  parseBrowserOperatorApprovalRecord,
} from './browser-approval-records.js';

const validApproval = {
  request_id: 'request-1',
  session_id: 'session-1',
  status: 'pending',
  message: 'Confirm the sensitive action',
  continue_file: 'active/shared/runtime/browser/session-1.continue',
  created_at: '2026-09-04T00:00:00.000Z',
  timeout_ms: 30_000,
};

describe('browser operator approval records', () => {
  it('validates the shape and strips unknown persisted fields', () => {
    expect(
      parseBrowserOperatorApprovalRecord({
        ...validApproval,
        unexpected: { value: true },
        completed_at: '2026-09-04T00:01:00.000Z',
      })
    ).toEqual({
      ...validApproval,
      completed_at: '2026-09-04T00:01:00.000Z',
    });
  });

  it('rejects dangerous keys and malformed fields', () => {
    const dangerous = { ...validApproval } as Record<string, unknown>;
    Object.defineProperty(dangerous, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    expect(() => parseBrowserOperatorApprovalRecord(dangerous)).toThrow('dangerous JSON key');
    expect(() =>
      parseBrowserOperatorApprovalRecord({ ...validApproval, status: 'granted' })
    ).toThrow('valid approval status');
    expect(() =>
      parseBrowserOperatorApprovalRecord({ ...validApproval, timeout_ms: Number.NaN })
    ).toThrow('finite non-negative number');
    expect(() =>
      parseBrowserOperatorApprovalRecord({ ...validApproval, created_at: 'not-a-date' })
    ).toThrow('valid timestamp');
  });

  it('requires a JSON object with the complete request identity', () => {
    expect(() => parseBrowserOperatorApprovalRecord([])).toThrow('must be a JSON object');
    expect(() => parseBrowserOperatorApprovalRecord({ ...validApproval, request_id: ' ' })).toThrow(
      'request_id must be a non-empty string'
    );
    expect(() => parseBrowserOperatorApprovalRecord({ ...validApproval, session_id: 42 })).toThrow(
      'session_id must be a non-empty string'
    );
  });

  it('fails closed for malformed or mismatched completion artifacts', () => {
    expect(
      completeBrowserOperatorApproval(
        '{"constructor":{}}',
        'session-1',
        'approved',
        '2026-09-04T00:02:00.000Z'
      )
    ).toEqual({ status: 'approved', completed_at: '2026-09-04T00:02:00.000Z' });
    expect(
      completeBrowserOperatorApproval(
        JSON.stringify(validApproval),
        'other-session',
        'rejected',
        '2026-09-04T00:02:00.000Z'
      )
    ).toEqual({ status: 'rejected', completed_at: '2026-09-04T00:02:00.000Z' });
  });
});
