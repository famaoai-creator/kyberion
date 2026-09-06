import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('reasoning route doctor environment boundary', () => {
  it('reads Anthropic availability through the environment registry', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/reasoning-route-doctor.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.ANTHROPIC_API_KEY');
    expect(source).toContain("getRegisteredEnvText('ANTHROPIC_API_KEY')");
  });
});
