import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext, withStoreGrant, withStoreGrantAsync } from '../authority.js';
import {
  liveDeclaredStoreGrant,
  openDeclaredStoreGrantToken,
  rolePermissionRecord,
} from './declared-store-grant.js';
import { currentExecutionScope, runInExecutionScope } from './execution-scope.js';

const GRANT = 'scope_locale_reader';
const POLICY = {
  authority_role_permissions: { mission_controller: { allow_read: ['active/'] } },
  store_grants: {
    [GRANT]: {
      description: 'test',
      allow_read: ['knowledge/confidential/${KYBERION_TENANT}/locale.json'],
      allow_write: [],
    },
  },
};
const ENV_KEYS = ['KYBERION_TENANT', 'SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_PERSONA'] as const;

describe('declared store grants (S4 slice 3)', () => {
  const saved: Record<string, string | undefined> = {};
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

  it('resolves the declaration only inside the grant its facade opened', () => {
    expect(rolePermissionRecord(POLICY, GRANT)).toBeUndefined();
    withStoreGrant(
      GRANT,
      () => {
        expect(liveDeclaredStoreGrant()).toBe(GRANT);
        expect(currentExecutionScope()?.tenantSlug).toBe('acme-corp');
        expect(rolePermissionRecord(POLICY, GRANT)).toBe(POLICY.store_grants[GRANT]);
        // A nested role assumption is a different scope without the grant.
        withExecutionContext('mission_controller', () => {
          expect(liveDeclaredStoreGrant()).toBeUndefined();
          expect(rolePermissionRecord(POLICY, GRANT)).toBeUndefined();
        });
      },
      { tenantSlug: 'acme-corp' }
    );
    expect(liveDeclaredStoreGrant()).toBeUndefined();
    expect(rolePermissionRecord(POLICY, GRANT)).toBeUndefined();
  });

  it('never resolves a forged, copied or expired token', () => {
    runInExecutionScope(
      { tenantBound: true, tenantSlug: 'acme-corp', assumedRole: GRANT, storeGrantToken: {} },
      () => expect(rolePermissionRecord(POLICY, GRANT)).toBeUndefined()
    );
    let stolen: object | undefined;
    withStoreGrant(GRANT, () => (stolen = currentExecutionScope()?.storeGrantToken), {
      tenantSlug: 'acme-corp',
    });
    expect(stolen).toBeDefined();
    runInExecutionScope(
      { tenantBound: true, tenantSlug: 'acme-corp', assumedRole: GRANT, storeGrantToken: stolen },
      () => expect(rolePermissionRecord(POLICY, GRANT)).toBeUndefined()
    );
    // A live token under another name resolves nothing either.
    withStoreGrant(
      GRANT,
      () => {
        const token = currentExecutionScope()?.storeGrantToken;
        runInExecutionScope(
          { tenantBound: false, assumedRole: 'mission_controller', storeGrantToken: token },
          () => expect(liveDeclaredStoreGrant()).toBeUndefined()
        );
      },
      { tenantSlug: 'acme-corp' }
    );
  });

  it('a role entry is never shadowed by a grant declaration', () => {
    withStoreGrant(
      GRANT,
      () =>
        expect(
          rolePermissionRecord(
            { authority_role_permissions: { [GRANT]: { allow_read: [] } }, store_grants: {} },
            GRANT
          )
        ).toEqual({ allow_read: [] }),
      { tenantSlug: 'acme-corp' }
    );
  });

  it('refuses unknown names and keeps the grant through an async result until it settles', async () => {
    expect(() => withStoreGrant('mission_controller', () => 1)).toThrow(/\[STORE_GRANT_UNKNOWN\]/);
    expect(() => openDeclaredStoreGrantToken('mission_controller')).toThrow(
      /\[STORE_GRANT_UNKNOWN\]/
    );
    const pending = withStoreGrant(
      GRANT,
      async () => {
        await Promise.resolve();
        return liveDeclaredStoreGrant();
      },
      { tenantSlug: 'acme-corp' }
    );
    await expect(pending).resolves.toBe(GRANT);
    await expect(
      withStoreGrantAsync(
        GRANT,
        async () => {
          await Promise.resolve();
          return liveDeclaredStoreGrant();
        },
        { tenantSlug: 'acme-corp' }
      )
    ).resolves.toBe(GRANT);
    expect(liveDeclaredStoreGrant()).toBeUndefined();
  });

  it('mirrors the name for raw-env readers and restores it', () => {
    process.env.MISSION_ROLE = 'surface_runtime';
    withStoreGrant(GRANT, () => expect(process.env.MISSION_ROLE).toBe(GRANT), {
      tenantSlug: 'acme-corp',
    });
    expect(process.env.MISSION_ROLE).toBe('surface_runtime');
  });
});
