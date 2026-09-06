import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readEnvRegistryTextFile } from './generate_env_registry.js';

describe('env registry generator catalog boundary', () => {
  it('loads the existing registry through the canonical loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_env_registry.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadEnvRegistryFile()');
    expect(source).toContain("getRegisteredEnv, readTextFile } from '@agent/core/foundation'");
    expect(source).toContain('readEnvRegistryTextFile(filePath: string)');
    expect(source).not.toContain('safeReadFile(filePath');
    expect(source).not.toContain('readJson<EnvRegistryFile>');
  });

  it('rejects a directory before reading source content', () => {
    expect(() => readEnvRegistryTextFile(pathResolver.rootResolve('libs'))).toThrow(
      'must be a regular file'
    );
  });
});
