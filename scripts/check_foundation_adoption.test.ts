import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  checkFoundationAdoption,
  countSimpleIsoTimestampViolations,
  readFoundationAdoptionTextFile,
} from './check_foundation_adoption.js';

describe('checkFoundationAdoption', () => {
  it('rejects a directory replacement before source inspection', () => {
    expect(() => readFoundationAdoptionTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for source inspection', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/check_foundation_adoption.ts'));
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
    expect(source).toContain("from '@agent/core/secure-io'");
  });

  it('detects multiline foundation JSON loader bypasses', () => {
    const filePath = pathResolver.sharedTmp('foundation-adoption-violation.ts');
    safeWriteFile(
      filePath,
      "const value = JSON.parse(\n  String(safeReadFile('policy.json'))\n);\n"
    );

    try {
      expect(checkFoundationAdoption([filePath])).toContain(
        'shared JSON loader pattern increased: 1 > 0'
      );
    } finally {
      safeRmSync(filePath, { force: true });
    }
  });

  it('accepts the foundation JSON reader', () => {
    const filePath = pathResolver.sharedTmp('foundation-adoption-compliant.ts');
    safeWriteFile(filePath, "import { readJsonIfPresent } from '@agent/core/foundation';\n");

    try {
      expect(checkFoundationAdoption([filePath])).toEqual([]);
    } finally {
      safeRmSync(filePath, { force: true });
    }
  });

  it('rejects duplicated simple ISO timestamp construction', () => {
    expect(countSimpleIsoTimestampViolations('const createdAt = new Date().toISOString();')).toBe(
      1
    );
    expect(countSimpleIsoTimestampViolations('const createdAt = nowIso();')).toBe(0);
  });
});
