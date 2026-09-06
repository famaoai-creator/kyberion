import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('terminal bridge HTTP input boundary', () => {
  it('uses the shared safe JSON object parser before session creation', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('presence/bridge/terminal/server.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('parseSafeJsonObjectValue');
    expect(source).toContain(
      "parseSafeJsonObjectValue(req.body === undefined ? {} : req.body, 'terminal session request')"
    );
  });
});
