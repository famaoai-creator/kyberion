import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('env registry generator catalog boundary', () => {
  it('loads the existing registry through the canonical loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_env_registry.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadEnvRegistryFile()');
    expect(source).not.toContain('readJson<EnvRegistryFile>');
  });
});
