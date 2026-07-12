import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

// IP-08 Task 2 finding (c): a corrupt security-policy.json used to fall
// through to `{ allowed: true }`, silently disabling tier isolation. These
// tests pin the repaired semantics: missing = bootstrap allow, corrupt =
// protected tiers fail closed while the rest of the workspace stays usable.

const state = {
  policyExists: true,
  policyText: '{ this is not json',
};

vi.mock('./fs-primitives.js', () => ({
  rawExistsSync: (p: string) => {
    if (p.includes('security-policy.json')) return state.policyExists;
    return false;
  },
  rawReadTextFile: (p: string) => {
    if (p.includes('security-policy.json')) return state.policyText;
    throw new Error(`unexpected read: ${p}`);
  },
}));

vi.mock('./authority.js', () => ({
  resolveIdentityContext: () => ({
    persona: 'test-persona',
    role: null,
    authorities: [],
    sudoScope: null,
    tenantSlug: null,
    brokeredTenants: [],
    brokerApproval: null,
  }),
}));

import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import { pathResolver } from './path-resolver.js';

const ROOT = pathResolver.rootDir();

describe('tier-guard policy corruption fail-closed (IP-08)', () => {
  beforeEach(() => {
    state.policyExists = true;
    state.policyText = '{ this is not json';
  });

  it('denies protected-tier writes when the policy file is corrupt', () => {
    const result = validateWritePermission(path.join(ROOT, 'knowledge/personal/notes.md'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot be parsed');
  });

  it('denies confidential reads when the policy file is corrupt', () => {
    const result = validateReadPermission(path.join(ROOT, 'knowledge/confidential/acme/plan.md'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot be parsed');
  });

  it('keeps non-protected paths writable so a corrupt policy does not brick the workspace', () => {
    const result = validateWritePermission(path.join(ROOT, 'active/shared/tmp/scratch.txt'));
    expect(result.allowed).toBe(true);
  });

  it('still allows bootstrap when the policy file is genuinely missing', () => {
    state.policyExists = false;
    const result = validateWritePermission(path.join(ROOT, 'knowledge/personal/notes.md'));
    expect(result.allowed).toBe(true);
  });
});
