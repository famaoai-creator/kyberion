import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { validateWritePermission } from '../tier-guard.js';
import {
  baseAuthorityRoleOf,
  baseAuthorityRolePermissionRecord,
  isBaseAuthorityRoleName,
  personaOfBaseAuthorityRole,
} from './base-authority-role.js';
import { rolePermissionRecord } from './declared-store-grant.js';

// S4 slice 4: the Execution Persona bundles are base Authority Roles. A
// principal reaches one only through its persona, never as its own role.
const ENV_KEYS = ['KYBERION_PERSONA', 'MISSION_ROLE', 'SYSTEM_ROLE', 'KYBERION_SUDO'] as const;
const BUNDLE = { allow_read: ['a/'], allow_write: ['b/'] };

describe('base Authority Roles (S4 slice 4)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('maps exactly the four bundled personas', () => {
    expect(baseAuthorityRoleOf('worker')).toBe('base_worker');
    expect(baseAuthorityRoleOf('mission_owner')).toBeUndefined();
    expect(baseAuthorityRoleOf('unknown')).toBeUndefined();
    expect(baseAuthorityRoleOf('toString')).toBeUndefined();
    expect(personaOfBaseAuthorityRole('base_analyst')).toBe('analyst');
    expect(personaOfBaseAuthorityRole('analyst')).toBeUndefined();
    expect(isBaseAuthorityRoleName('base_sovereign')).toBe(true);
    expect(isBaseAuthorityRoleName('sovereign')).toBe(false);
  });

  it('resolves the base role record, and a pre-base-role catalog from persona_permissions', () => {
    expect(
      baseAuthorityRolePermissionRecord(
        { authority_role_permissions: { base_worker: BUNDLE } },
        'worker'
      )
    ).toBe(BUNDLE);
    expect(
      baseAuthorityRolePermissionRecord(
        { authority_role_permissions: {}, persona_permissions: { worker: BUNDLE } },
        'worker'
      )
    ).toBe(BUNDLE);
    // The registry wins over a leftover legacy entry.
    expect(
      baseAuthorityRolePermissionRecord(
        {
          authority_role_permissions: { base_worker: BUNDLE },
          persona_permissions: { worker: { allow_write: ['/'] } },
        },
        'worker'
      )
    ).toBe(BUNDLE);
    expect(
      baseAuthorityRolePermissionRecord(
        { authority_role_permissions: { base_worker: BUNDLE } },
        'mission_owner'
      )
    ).toBeUndefined();
  });

  it('is never a principal own role: no record as a role, and no assumption', () => {
    expect(
      rolePermissionRecord(
        { authority_role_permissions: { base_sovereign: BUNDLE } },
        'base_sovereign'
      )
    ).toBeUndefined();
    expect(() => withExecutionContext('base_sovereign', () => undefined)).toThrow(
      /\[ROLE_ASSUMPTION_DENIED\]/
    );
    // MISSION_ROLE=base_sovereign with a worker persona writes no more than a plain worker.
    const target = path.join(pathResolver.rootDir(), 'libs/core/base-role-probe.ts');
    process.env.KYBERION_PERSONA = 'worker';
    const plain = validateWritePermission(target).allowed;
    process.env.MISSION_ROLE = 'base_sovereign';
    expect(validateWritePermission(target).allowed).toBe(plain);
    process.env.KYBERION_PERSONA = 'sovereign';
    delete process.env.MISSION_ROLE;
    expect(validateWritePermission(target).allowed).toBe(true);
  });
});
