import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeReaddir, safeStat } from '../secure-io.js';
import {
  loadAuthorityRoleCards,
  loadOrgRoleCards,
  projectRoleAuthorityMap,
  validateOrgRoleCards,
  type OrgRoleCard,
} from './authority-role-registry.js';

function card(role: string, overrides: Partial<OrgRoleCard['default_grant']> = {}): OrgRoleCard {
  return {
    role,
    role_class: 'context',
    default_grant: {
      authority_role: null,
      base_role: 'worker',
      execution_mode: 'mission',
      ...overrides,
    },
  };
}

const REGISTRY = { software_developer: {}, base_worker: {}, base_analyst: {} };

describe('Org Role cards (concept model v2 D6)', () => {
  it('accepts cards that point at registry entries', () => {
    expect(
      validateOrgRoleCards(
        {
          a: card('a', { authority_role: 'software_developer' }),
          b: card('b', { base_role: 'analyst' }),
          c: card('c', { base_role: 'mission_owner' }),
        },
        REGISTRY
      )
    ).toEqual([]);
  });

  it('rejects an unknown authority_role, a base role as authority_role, and an unknown base_role', () => {
    const errors = validateOrgRoleCards(
      {
        a: card('a', { authority_role: 'no_such_role' }),
        b: card('b', { authority_role: 'base_worker' }),
        c: card('c', { base_role: 'overlord' }),
        d: card('d', { base_role: 'sovereign' }),
      },
      REGISTRY
    );
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/^a: authority_role 'no_such_role' has no card/);
    expect(errors[1]).toMatch(/^b: authority_role 'base_worker' is a base role/);
    expect(errors[2]).toMatch(/^c: base_role 'overlord' is not a known base role/);
    expect(errors[3]).toMatch(/^d: base_role 'sovereign' has no registry card base_sovereign/);
  });

  it('projects cards into the map groups, keeping the existing order and appending new roles sorted', () => {
    const cards: Record<string, OrgRoleCard> = {
      zed: card('zed'),
      alpha: card('alpha', { authority_role: 'software_developer' }),
      mid: { ...card('mid'), role_class: 'system' },
      beta: card('beta'),
    };
    const groups = projectRoleAuthorityMap(cards, { context_roles: ['zed', 'gone'] });
    expect(groups.system_roles).toEqual([
      { role: 'mid', persona: 'worker', execution_mode: 'mission' },
    ]);
    expect(groups.mission_roles).toEqual([]);
    expect(groups.context_roles.map((entry) => entry.role)).toEqual(['zed', 'alpha', 'beta']);
    expect(groups.context_roles[1]).toEqual({
      role: 'alpha',
      authority_role: 'software_developer',
      persona: 'worker',
      execution_mode: 'mission',
    });
  });

  it('gives every Org Role directory a valid card and keeps role-authority-map.json its projection', () => {
    const rolesDir = pathResolver.knowledge('product/roles');
    const directories = safeReaddir(rolesDir)
      .filter((entry) => safeStat(path.join(rolesDir, entry)).isDirectory())
      .sort();
    const cards = loadOrgRoleCards();
    expect(Object.keys(cards).sort()).toEqual(directories);
    expect(validateOrgRoleCards(cards, loadAuthorityRoleCards() ?? {})).toEqual([]);

    const map = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/governance/role-authority-map.json'), {
        encoding: 'utf8',
      }) as string
    ) as Record<string, Array<{ role: string }>>;
    const order = {
      system_roles: map.system_roles!.map((entry) => entry.role),
      mission_roles: map.mission_roles!.map((entry) => entry.role),
      context_roles: map.context_roles!.map((entry) => entry.role),
    };
    const projected = projectRoleAuthorityMap(cards, order);
    expect({
      system_roles: map.system_roles,
      mission_roles: map.mission_roles,
      context_roles: map.context_roles,
    }).toEqual(projected);
  });
});
