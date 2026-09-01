import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('meeting actuator resource boundary', () => {
  it('revalidates voice consent evidence before reading', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/meeting-actuator/src/meeting-actuator-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('const consentPath = assertSafeRepositoryPath(');
    expect(source).toMatch(/allowMissingLeaf:\s*true/u);
  });
});
