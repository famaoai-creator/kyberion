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
    expect(routeSource).toContain('core.safeLstat(securityPolicyPath).isFile()');
    expect(routeSource).toContain('core.safeLstat(requestArtifactPath).isFile()');
    expect(routeSource).toContain('readJsonLines: foundation.readJsonLines');
    expect(routeSource).toContain('function readSafeChronosJsonLines(');
    expect(routeSource).toContain('readSafeChronosJsonLines(core, file).slice(-12)');
    expect(routeSource).toContain('loadStateAtPath: missionState.loadStateAtPath');
    expect(helperSource).toContain('core.loadStateAtPath(');
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

  it('passes the normalized request locale into the shared conversation contract', () => {
    const routeSource = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(routeSource).toContain('text: query,\n      locale,\n      threadTs: sessionId');
  });
});
