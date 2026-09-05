import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { validateDesignLedger } from './check_design_ledger.js';

const fixtureRoot = pathResolver.shared('tmp/design-ledger-check');

describe('design ledger checker', () => {
  it('uses the foundation text reader for ledger markdown files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_design_ledger.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('rejects a rejected note without a rationale and accepts a complete note', () => {
    safeMkdir(`${fixtureRoot}/docs/developer/design-notes/rejected`, { recursive: true });
    safeMkdir(`${fixtureRoot}/docs/developer/design-notes/implemented`, { recursive: true });
    safeMkdir(`${fixtureRoot}/docs/developer/postmortem`, { recursive: true });
    safeWriteFile(
      `${fixtureRoot}/docs/developer/design-notes/rejected/bad.md`,
      '---\ntitle: bad\nstatus: rejected\ndecision_date: 2026-08-17\nscope: test\ndecision: no\n---\n'
    );
    safeWriteFile(
      `${fixtureRoot}/docs/developer/design-notes/implemented/good.md`,
      '---\ntitle: good\nstatus: implemented\ndecision_date: 2026-08-17\nscope: test\ndecision: yes\nevidence: test file\n---\n'
    );
    safeWriteFile(
      `${fixtureRoot}/docs/developer/postmortem/good.md`,
      '---\nincident: test\nimpact: none\ntrace_or_example: fixture\nroot_cause: test\nprevention: checker\n---\n'
    );
    const violations = validateDesignLedger(fixtureRoot);
    expect(violations).toEqual([
      expect.objectContaining({
        file: 'active/shared/tmp/design-ledger-check/docs/developer/design-notes/rejected/bad.md',
        message: 'rejected note requires non-empty "rationale"',
      }),
    ]);
  });
});
