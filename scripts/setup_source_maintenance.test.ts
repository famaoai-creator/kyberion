import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { validateWritePermission } from '@agent/core/tier-guard';

function maintenancePermission(file: string) {
  return withExecutionContext(
    'ecosystem_architect',
    () => validateWritePermission(pathResolver.rootResolve(file)),
    'ecosystem_architect'
  );
}

describe('approved Quickstart maintenance scope', () => {
  it('allows the exact Quickstart file through the governed writer context', () => {
    expect(maintenancePermission('docs/QUICKSTART.md').allowed).toBe(true);
  });

  it.each(['docs/INITIALIZATION.md', 'docs/QUICKSTART.md.extra', 'docs/unrelated.md'])(
    'does not expand permission to neighboring document %s',
    (file) => {
      expect(maintenancePermission(file)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('POLICY_VIOLATION'),
      });
    }
  );

  it('adds no directory-wide documentation or personal-data grant to the maintenance persona', () => {
    const policy = readJson<{
      persona_permissions: { ecosystem_architect: { allow_write: string[] } };
    }>(pathResolver.rootResolve('knowledge/product/governance/security-policy.json'));
    const writes = policy.persona_permissions.ecosystem_architect.allow_write;
    expect(writes.filter((entry) => entry.startsWith('docs/'))).toEqual([
      'docs/developer/',
      'docs/CLI_REFERENCE.md',
      'docs/QUICKSTART.md',
    ]);
    expect(writes).not.toContain('knowledge/personal/');
    expect(writes).not.toContain('knowledge/confidential/');
    // This verifies the added persona grant only. Intrinsic authorities are an
    // independent pre-existing boundary and are deliberately not changed here.
  });
  it.each([
    'knowledge/personal/startup-readiness-boundary-probe.json',
    'knowledge/confidential/unrelated/startup-readiness-boundary-probe.json',
  ])('leaves the pre-grant guard result unchanged for %s', (file) => {
    // Read-only validateWritePermission results recorded before the exact-file
    // grant: these hypothetical paths both returned { allowed: true }. This is
    // a non-expansion regression, not a claim about the full secure-io chain.
    // No personal/confidential file is read or written by this test.
    const beforeGrant = { allowed: true };
    expect(maintenancePermission(file)).toEqual(beforeGrant);
  });
});
