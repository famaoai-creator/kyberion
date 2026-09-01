import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { checkFoundationAdoption } from './check_foundation_adoption.js';

describe('checkFoundationAdoption', () => {
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
});
