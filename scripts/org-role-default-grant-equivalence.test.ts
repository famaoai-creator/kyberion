/**
 * S4 (concept model v2 D6): an Org Role's default Grant moved from the
 * hand-kept knowledge/product/governance/role-authority-map.json onto the Org
 * Role card (knowledge/product/roles/<role>/role.json `default_grant`); the map
 * became a generated projection of the cards. No reader result may change.
 *
 * The "before" table (tests/fixtures/org-role-default-grant-equivalence.json)
 * was recorded on 91f99beef, while the map was still hand-kept. For every
 * role in the map, plus an unknown role and the empty role, it holds what each
 * reader of the map returns:
 * - `map`: the entry as `loadRoleAuthorityMapPersonas` (authority.ts) and
 *   `loadRoleAuthorityMap` (scripts/org.ts) read it;
 * - `infer`: `inferPersonaFromRole(role)`;
 * - `env`: `resolveIdentityContext()` base role and authorities for a process
 *   running with `MISSION_ROLE=<role>` and no base role env;
 * - `scope`: the persona `withExecutionContext(role)` binds (or the error code);
 * and `existing_role_ids`: `collectExistingRoleIds(root)` (scripts/org.ts),
 * which reserves every map role and authority_role.
 *
 * Re-record (only when a default grant itself changes, never to hide a difference):
 *   KYBERION_RECORD_ORG_ROLE_GRANT_EQUIVALENCE=1 pnpm exec vitest run scripts/org-role-default-grant-equivalence.test.ts
 * then copy active/shared/tmp/org-role-default-grant-equivalence.json over the fixture.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  inferPersonaFromRole,
  resolveExecutionPersona,
  resolveIdentityContext,
  withExecutionContext,
} from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { collectExistingRoleIds } from './org.js';

const ROOT = pathResolver.rootDir();
const FIXTURE = 'tests/fixtures/org-role-default-grant-equivalence.json';
const MAP = 'knowledge/product/governance/role-authority-map.json';
const GROUPS = ['system_roles', 'mission_roles', 'context_roles'] as const;
const EXTRA_ROLES = ['no_such_org_role', ''] as const;

const ENV_KEYS = [
  'KYBERION_BASE_ROLE',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_DELEGATED_ROLE',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'MISSION_ID',
] as const;

interface MapEntry {
  group: string;
  authority_role?: string;
  persona: string;
  execution_mode?: string;
}

interface RoleRow {
  map: MapEntry | null;
  infer: string;
  env: { baseRole: string; authorities: string[] };
  scope: string;
}

interface EquivalenceFixture {
  roles: Record<string, RoleRow>;
  existing_role_ids: string[];
}

const recording = process.env.KYBERION_RECORD_ORG_ROLE_GRANT_EQUIVALENCE === '1';

function loadJson<T>(relative: string): T {
  return JSON.parse(safeReadFile(path.join(ROOT, relative), { encoding: 'utf8' }) as string) as T;
}

function readMapEntries(): Record<string, MapEntry> {
  const raw = loadJson<Record<string, unknown>>(MAP);
  const entries: Record<string, MapEntry> = {};
  for (const group of GROUPS) {
    const list = raw[group];
    if (!Array.isArray(list)) continue;
    for (const value of list as Array<Record<string, string>>) {
      entries[value.role!] = {
        group,
        ...(value.authority_role ? { authority_role: value.authority_role } : {}),
        persona: value.persona!,
        ...(value.execution_mode ? { execution_mode: value.execution_mode } : {}),
      };
    }
  }
  return entries;
}

function withCleanEnv<T>(role: string, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  if (role) process.env.MISSION_ROLE = role;
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `THROW:${message.match(/\[([A-Z][A-Z0-9_]+)\]/u)?.[1] ?? 'ERROR'}`;
}

function roleRow(role: string, map: Record<string, MapEntry>): RoleRow {
  const env = withCleanEnv(role, () => {
    const identity = resolveIdentityContext();
    return { baseRole: identity.baseRole, authorities: [...identity.authorities].sort() };
  });
  const scope = withCleanEnv('', () => {
    if (!role) return 'NO_ROLE';
    try {
      return withExecutionContext(role, () => resolveExecutionPersona() ?? 'NONE');
    } catch (error) {
      return errorCode(error);
    }
  });
  return { map: map[role] ?? null, infer: inferPersonaFromRole(role), env, scope };
}

function buildTable(roleNames: readonly string[]): EquivalenceFixture {
  const map = readMapEntries();
  return {
    roles: Object.fromEntries(roleNames.map((role) => [role, roleRow(role, map)])),
    existing_role_ids: [...collectExistingRoleIds(ROOT)].sort(),
  };
}

describe('Org Role default grant: role-authority-map readers (S4, D6)', () => {
  if (recording) {
    it('records the before table', () => {
      const roleNames = [...Object.keys(readMapEntries()).sort(), ...EXTRA_ROLES];
      safeWriteFile(
        pathResolver.shared('tmp/org-role-default-grant-equivalence.json'),
        `${JSON.stringify(buildTable(roleNames), null, 2)}\n`
      );
    });
    return;
  }

  const fixture = loadJson<EquivalenceFixture>(FIXTURE);

  it('keeps the same set of map roles', () => {
    expect(Object.keys(readMapEntries()).sort()).toEqual(
      Object.keys(fixture.roles)
        .filter((role) => !(EXTRA_ROLES as readonly string[]).includes(role))
        .sort()
    );
  });

  it('returns the recorded result from every reader for every role', () => {
    const after = buildTable(Object.keys(fixture.roles));
    expect(after.roles).toEqual(fixture.roles);
  });

  it('reserves the same existing role ids', () => {
    expect([...collectExistingRoleIds(ROOT)].sort()).toEqual(fixture.existing_role_ids);
  });
});
