import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readPayload } from './google_workspace_meet.js';

describe('google workspace meet payload boundaries', () => {
  it('rejects payload files outside the repository before checking existence', () => {
    expect(() => readPayload({ '--payload-file': '../outside.json' })).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => readPayload({ '--payload-file': '/tmp/outside.json' })).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects non-object and dangerous JSON before the gws call', () => {
    expect(() => readPayload({ '--json': '[]' })).toThrow(
      'Google Workspace Meet payload must be a JSON object'
    );
    expect(() => readPayload({ '--json': '{"constructor":{"polluted":true}}' })).toThrow(
      'Google Workspace Meet payload contains a dangerous JSON key'
    );
  });

  it('routes usage and gws output through the shared printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/google_workspace_meet.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});
