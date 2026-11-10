import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

// IP-08 Task 2 finding (c): a corrupt security-policy.json used to fall
// through to `{ allowed: true }`, silently disabling tier isolation. These
// tests pin the repaired semantics: missing = bootstrap allow, corrupt =
// protected tiers fail closed while the rest of the workspace stays usable.

const state = {
  policyExists: true,
  policyText: '{ this is not json',
  policySequence: undefined as string[] | undefined,
  policyReads: 0,
};

vi.mock('./fs-primitives.js', () => ({
  rawExistsSync: (p: string) => {
    if (p.includes('security-policy.json')) return state.policyExists;
    return false;
  },
  rawReadTextFile: (p: string) => {
    if (p.includes('security-policy.json')) {
      const index = state.policyReads++;
      return (
        state.policySequence?.[Math.min(index, state.policySequence.length - 1)] ?? state.policyText
      );
    }
    throw new Error(`unexpected read: ${p}`);
  },
}));

vi.mock('./authority.js', () => ({
  resolveIdentityContext: () => ({
    baseRole: 'test-persona',
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
import { runInResourceAccessScope } from './foundation/resource-access-scope.js';

const ROOT = pathResolver.rootDir();

describe('tier-guard policy corruption fail-closed (IP-08)', () => {
  beforeEach(() => {
    vi.stubEnv('SYSTEM_ROLE', undefined);
    vi.stubEnv('MISSION_ROLE', undefined);
    state.policyExists = true;
    state.policyText = '{ this is not json';
    state.policySequence = undefined;
    state.policyReads = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does not combine narrowing and base allows from different policy versions', () => {
    const target = 'active/shared/tmp/policy-snapshot.txt';
    const role = 'snapshot_role';
    const first = JSON.stringify({
      default_allow: false,
      authority_role_permissions: {
        [role]: { write: [], narrow: { only: { write: [{ path: target }] } } },
      },
    });
    const second = JSON.stringify({
      default_allow: true,
      authority_role_permissions: {
        [role]: { write: [target], narrow: { only: { write: [{ path: target + '.other' }] } } },
      },
    });
    vi.stubEnv('SYSTEM_ROLE', role);
    for (const policy of [first, second]) {
      state.policyText = policy;
      expect(validateWritePermission(path.join(ROOT, target)).allowed).toBe(false);
    }
    state.policyReads = 0;
    state.policySequence = [first, second];
    expect(validateWritePermission(path.join(ROOT, target)).allowed).toBe(false);
    expect(state.policyReads).toBe(1);
  });

  it.each([
    'deliverable_inbox_writer',
    'customer_channel_binding_store',
    'archived_mission_state_reader',
    'concierge_management_reader',
    'concierge_management_writer',
  ])('does not erase %s restrictions when policy is unavailable', (role) => {
    // S4: these names are declared store grants. A process running as one through env
    // holds no live grant and is refused before the policy is consulted
    // ([STORE_GRANT_REQUIRED]); inside a live grant the same narrowing stage refuses with
    // [ROLE_NARROWING_POLICY_UNAVAILABLE]. Either way nothing is admitted.
    const refusal = /ROLE_NARROWING_POLICY_UNAVAILABLE|STORE_GRANT_REQUIRED/;
    const target = 'active/shared/inbox/entries.jsonl';
    const foreign = 'active/shared/inbox/another.jsonl';
    vi.stubEnv('SYSTEM_ROLE', role);
    for (const policyExists of [false, true]) {
      state.policyExists = policyExists;
      state.policyText = '{ this is not json';
      for (const scoped of [false, true]) {
        const probe = () => {
          for (const relative of [target, foreign]) {
            const file = path.join(ROOT, relative);
            for (const operation of ['write', 'append', 'mkdir'] as const) {
              const decision = validateWritePermission(file, operation, '{"id":"replacement"}\n');
              expect(decision.allowed).toBe(false);
              expect(decision.reason).toMatch(refusal);
            }
            for (const operation of ['read', 'metadata'] as const) {
              const decision = validateReadPermission(file, operation);
              expect(decision.allowed).toBe(false);
              expect(decision.reason).toMatch(refusal);
            }
          }
        };
        if (scoped)
          runInResourceAccessScope(
            {
              tenantSlug: 'acme-corp',
              readExact: [target, foreign],
              writeExact: [target, foreign],
              mkdirExact: [target, foreign],
              allowProductKnowledgeRead: false,
            },
            probe
          );
        else probe();
      }
    }
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

  it('fails closed when the policy contains a dangerous JSON key', () => {
    state.policyText = '{"read":{},"__proto__":{"allow":true}}';
    const result = validateReadPermission(path.join(ROOT, 'knowledge/personal/notes.md'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot be parsed');
  });
});
