import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './compose_mission_team.js';

describe('mission team composition entrypoint', () => {
  it('keeps composition output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/compose_mission_team.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result)');
    expect(source).toContain('loadStateAtPath(');
    expect(source).not.toContain('readJson<');
    expect(source).not.toContain('console.log(');
  });

  it('handles help without requiring a mission or writing bindings', async () => {
    await expect(main(['--help'])).resolves.toEqual({
      status: 'help',
      usage: expect.stringContaining('mission:compose-team'),
    });
  });
});
