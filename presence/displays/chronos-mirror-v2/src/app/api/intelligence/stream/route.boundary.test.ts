import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('Chronos intelligence stream execution boundary', () => {
  it('does not leave a request-derived mission role in process-wide env', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'presence/displays/chronos-mirror-v2/src/app/api/intelligence/stream/route.ts'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(source).not.toContain('process.env.MISSION_ROLE =');
    expect(source).toContain('withViewerExecutionContextAsync(resolvedViewer.context');
  });
});
