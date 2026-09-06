import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('provider CLI capability report catalog boundary', () => {
  it('uses the governed adapter registry loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_provider_cli_capability_report.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('defineCatalog<AdapterRegistry>');
    expect(source).toContain('adapterRegistryCatalog.load()');
    expect(source).toContain('defineGenerator');
    expect(source).toContain('runGenerateProviderCliCapabilityReport');
    expect(source).toContain('assertSafeRepositoryPath(');
    expect(source).not.toContain('readFoundationJson');
    expect(source).not.toContain('function readJson');
    expect(source).not.toContain('defineScript');
  });
});
