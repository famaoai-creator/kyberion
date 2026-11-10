import { describe, expect, it } from 'vitest';
import {
  loadAuthorityRoleCards,
  loadAuthorityRoleIndex,
  projectAuthorityRolePermissions,
  type AuthorityRoleCard,
} from '@agent/core/organization/authority-role-registry';
import { validateAuthorityRolePermissionProjection } from './check-governance-directory-consistency.js';

const cards: Record<string, AuthorityRoleCard> = {
  zeta_store: { role: 'zeta_store', assignable: false, permissions: { allow_write: ['z/'] } },
  alpha: {
    role: 'alpha',
    description: 'assignable',
    write_scopes: [],
    scope_classes: [],
    allowed_actuators: [],
    tier_access: ['public'],
    permissions: { allow_read: ['a/'] },
  },
  profile_only: {
    role: 'profile_only',
    description: 'assignable, no path permissions',
    write_scopes: [],
    scope_classes: [],
    allowed_actuators: [],
    tier_access: ['public'],
  },
  beta_runner: { role: 'beta_runner', assignable: false, permissions: { allow_write: ['b/'] } },
};

describe('authority role registry (concept model v2 D6)', () => {
  it('projects only declared permissions, verbatim, keeping the existing policy order', () => {
    const projection = projectAuthorityRolePermissions(cards, ['zeta_store', 'gone', 'alpha']);
    expect(Object.keys(projection)).toEqual(['zeta_store', 'alpha', 'beta_runner']);
    expect(projection.zeta_store).toBe(cards.zeta_store!.permissions);
    expect(Object.hasOwn(projection, 'profile_only')).toBe(false);
  });

  it('keeps process roles out of the assignable catalog and registry fields out of profiles', () => {
    const live = loadAuthorityRoleCards();
    expect(live).not.toBeNull();
    const index = loadAuthorityRoleIndex();
    for (const [role, card] of Object.entries(live!)) {
      if (card.assignable === false) {
        expect(index[role], role).toBeUndefined();
      } else {
        expect(index[role], role).toBeDefined();
        expect(Object.hasOwn(index[role]!, 'permissions')).toBe(false);
        expect(Object.hasOwn(index[role]!, 'assignable')).toBe(false);
      }
    }
  });

  it('the live security policy is exactly the registry projection', () => {
    const violations: string[] = [];
    validateAuthorityRolePermissionProjection(loadAuthorityRoleCards()!, violations);
    expect(violations).toEqual([]);
  });

  it('fails the drift gate on an undeclared, missing or edited role permission', () => {
    const violations: string[] = [];
    validateAuthorityRolePermissionProjection(cards, violations, {
      authority_role_permissions: {
        zeta_store: { allow_write: ['z/', 'widened/'] },
        alpha: { allow_read: ['a/'] },
        rogue_role: { allow_write: ['/'] },
      },
    });
    expect(violations).toEqual([
      expect.stringContaining('authority_role_permissions.zeta_store differs'),
      expect.stringContaining('authority_role_permissions.rogue_role has no card'),
      expect.stringContaining('authority_role_permissions.beta_runner is missing'),
    ]);
  });
});
