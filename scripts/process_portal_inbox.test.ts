import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { parsePortalRequest, readPortalInboxTextFile } from './process_portal_inbox.js';

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

  it('routes portal notifications through the shared printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/process_portal_inbox.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.warn');
    expect(source).toContain('run({ print })');
    expect(source).toContain('return processInbox(print)');
  });

  it('rejects a directory before reading an inbox request', () => {
    expect(() => readPortalInboxTextFile(pathResolver.rootResolve('active'))).toThrow(
      'must be a regular file'
    );
  });
});
