import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  collectUiUxGovernanceReport,
  findHardcodedColorViolations,
  readUiUxGovernanceTextFile,
} from './check_ui_ux_governance.js';

describe('UI/UX governance audit', () => {
  it('rejects raw colors in operator-facing source', () => {
    expect(
      findHardcodedColorViolations("const style = { color: '#ff00aa' };", 'example.tsx')
    ).toEqual([
      expect.objectContaining({
        rule: 'hardcoded-color',
        path: 'example.tsx',
      }),
    ]);
  });

  it('keeps the repository UI/UX governance contract green', () => {
    const report = collectUiUxGovernanceReport(new Date('2026-07-13T00:00:00.000Z'));
    expect(report.status, JSON.stringify(report.violations, null, 2)).toBe('pass');
    expect(report.owner).toBe('design-system-steward');
    expect(report.checked_files).toBeGreaterThan(10);
  });

  it('uses the foundation text reader for source inspection', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/check_ui_ux_governance.ts'));
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile');
  });

  it('rejects a directory replacement before governance text parsing', () => {
    expect(() => readUiUxGovernanceTextFile(pathResolver.rootDir())).toThrow(
      'must be a regular file'
    );
  });
});
