import { describe, expect, it } from 'vitest';
import {
  collectUiUxGovernanceReport,
  findHardcodedColorViolations,
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
});
