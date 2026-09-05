import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('promote procedure resource boundaries', () => {
  it('uses the governed parser for intent phrase input', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/promote_procedure.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain("parseSafeJsonInput(intentPhrasesRaw || '[]', '--intent-phrases')");
    expect(source).not.toContain('JSON.parse(intentPhrasesRaw)');
    expect(source).toContain('readProcedureCatalog(catalogAbs)');
    expect(source).toContain('validateProcedureCatalog(catalog, catalogAbs)');
    expect(source).not.toContain('readJson<ProcedureCatalog>');
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
  });
});
