import { describe, expect, it } from 'vitest';
import {
  CORE_WORKING_PRINCIPLES,
  ROLE_WORKING_PRINCIPLES,
  buildWorkingPrinciplesLines,
  resolveRoleAddendum,
} from './working-principles.js';

describe('working principles brief', () => {
  it('compact mode stays lean: header + 6 core rules + role addendum', () => {
    const lines = buildWorkingPrinciplesLines('implementer');
    expect(lines[0]).toContain('## Working principles');
    const ruleLines = lines.filter((line) => line.startsWith('- '));
    expect(ruleLines).toHaveLength(6 + ROLE_WORKING_PRINCIPLES.implementer.length);
    // the highest-leverage rules survive compaction
    expect(lines.join('\n')).toContain('Never retry a failed action unchanged');
    expect(lines.join('\n')).toContain('"Done" requires evidence');
  });

  it('full mode emits all core rules', () => {
    const lines = buildWorkingPrinciplesLines(undefined, { compact: false });
    const ruleLines = lines.filter((line) => line.startsWith('- '));
    expect(ruleLines).toHaveLength(CORE_WORKING_PRINCIPLES.length);
  });

  it('role aliases map to canonical addenda and unknown roles degrade to core-only', () => {
    expect(resolveRoleAddendum('implementation_architect')).toEqual(
      ROLE_WORKING_PRINCIPLES.implementer
    );
    expect(resolveRoleAddendum('QA')).toEqual(ROLE_WORKING_PRINCIPLES.qa);
    expect(resolveRoleAddendum('ui_designer')).toEqual(ROLE_WORKING_PRINCIPLES.designer);
    expect(resolveRoleAddendum('unknown-role')).toEqual([]);
    expect(resolveRoleAddendum()).toEqual([]);
    // unknown role still yields a valid brief
    const lines = buildWorkingPrinciplesLines('unknown-role');
    expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(6);
  });

  it('reviewer addendum enforces refutation-with-evidence', () => {
    const text = buildWorkingPrinciplesLines('reviewer').join('\n');
    expect(text).toContain('refute');
    expect(text).toContain('[reviewer]');
  });

  it('every rule is a single line (prompt-safe)', () => {
    for (const rule of [
      ...CORE_WORKING_PRINCIPLES,
      ...Object.values(ROLE_WORKING_PRINCIPLES).flat(),
    ]) {
      expect(rule).not.toContain('\n');
      expect(rule.trim().length).toBeGreaterThan(20);
    }
  });
});
