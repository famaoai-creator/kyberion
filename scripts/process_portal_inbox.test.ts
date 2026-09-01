import { describe, expect, it } from 'vitest';
import { parsePortalRequest } from './process_portal_inbox.js';

describe('process_portal_inbox input boundary', () => {
  it('normalizes a valid pending request without dropping extension fields', () => {
    expect(
      parsePortalRequest('{"intent":"  security review  ","status":"pending","trace_id":"t-1"}')
    ).toEqual({ intent: 'security review', status: 'pending', trace_id: 't-1' });
  });

  it.each([
    'not-json',
    'null',
    '[]',
    '{"intent":"security","status":"unknown"}',
    '{"intent":"   ","status":"pending"}',
    '{"intent":[],"status":"pending"}',
    '{"intent":"security","status":"pending","__proto__":{"polluted":true}}',
  ])('rejects malformed request %s', (raw) => {
    expect(parsePortalRequest(raw)).toBeNull();
  });
});
