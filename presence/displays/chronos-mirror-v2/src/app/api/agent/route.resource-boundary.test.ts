import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('chronos agent route resource boundary', () => {
  it('uses the secure JSON facade for quick-action mission projections', () => {
    const routeSource = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts'),
        { encoding: 'utf8' }
      )
    );
    const helperSource = String(
      safeReadFile(
        pathResolver.rootResolve(
          'presence/displays/chronos-mirror-v2/src/app/api/agent/chronos-quick-action-helpers.ts'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(routeSource).toContain('assertSafeRepositoryPath: secureIo.assertSafeRepositoryPath');
    expect(helperSource).toContain('core.readJson<unknown>(');
    expect(`${routeSource}\n${helperSource}`).not.toContain('core.loadJson');
  });

  it('keeps the toolchain quick action on the canonical bootstrap command', () => {
    const routeSource = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(routeSource).toContain("['env:bootstrap', '--manifest', 'kyberion-toolchain']");
    expect(routeSource).not.toContain("['prereq:check']");
  });
});
