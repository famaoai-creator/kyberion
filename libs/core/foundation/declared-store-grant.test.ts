import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Disclosure grants record to the audit chain: observe (and fail) the record.
const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../governance/audit-chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../governance/audit-chain.js')>();
  return { ...actual, auditChain: { ...actual.auditChain, record: audit.record } };
});

import {
  recordStoreGrantDisclosure,
  withExecutionContext,
  withStoreGrant,
  withStoreGrantAsync,
} from '../authority.js';
import { runInResourceAccessScope } from './resource-access-scope.js';
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

  it('a role entry under a grant name never changes what the grant permits', () => {
    const shadow = {
      authority_role_permissions: { [GRANT]: { allow_read: ['knowledge/'] } },
      store_grants: {},
    };
    expect(rolePermissionRecord(shadow, GRANT)).toBeUndefined();
    withStoreGrant(GRANT, () => expect(rolePermissionRecord(shadow, GRANT)).toBeUndefined(), {
      tenantSlug: 'acme-corp',
    });
    withStoreGrant(
      GRANT,
      () => expect(rolePermissionRecord(POLICY, GRANT)).toBe(POLICY.store_grants[GRANT]),
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

  it('records every cross-store read grant as an audited disclosure, and refuses it unaudited', () => {
    audit.record.mockReset();
    expect(withStoreGrant('workspace_graph_reader', () => 'read', { tenantSlug: '' })).toBe('read');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'store_grant.disclosure',
      operation: 'workspace_graph_reader',
      result: 'allowed',
    });
    // A non-disclosure grant records nothing.
    withStoreGrant(GRANT, () => undefined, { tenantSlug: 'acme-corp' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    audit.record.mockImplementationOnce(() => {
      throw new Error('audit persistence down');
    });
    const ran = vi.fn();
    expect(() => withStoreGrant('workspace_graph_reader', ran, { tenantSlug: '' })).toThrow(
      /\[STORE_GRANT_DISCLOSURE_UNAUDITED\]/
    );
    expect(ran).not.toHaveBeenCalled();
    audit.record.mockReset();
  });

  it('accepts a pre-recorded disclosure receipt once, for its grant and tenant only', () => {
    audit.record.mockReset();
    const ceiling = {
      tenantSlug: 'acme-corp',
      readExact: ['knowledge/personal/tenants/acme-corp.json'],
      writeExact: [],
      mkdirExact: [],
    };
    const open = (receipt: object | undefined, tenantSlug = 'acme-corp') =>
      runInResourceAccessScope({ ...ceiling, tenantSlug }, () =>
        withStoreGrant('concierge_management_reader', () => 'read', {
          tenantSlug,
          ...(receipt ? { disclosureReceipt: receipt } : {}),
        })
      );
    const receipt = recordStoreGrantDisclosure('concierge_management_reader', {
      tenantSlug: 'acme-corp',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(open(receipt)).toBe('read');
    expect(() => open(receipt)).toThrow(/\[STORE_GRANT_DISCLOSURE_UNAUDITED\]/);
    const other = recordStoreGrantDisclosure('concierge_management_reader', {
      tenantSlug: 'acme-corp',
    });
    expect(() => open(other, 'other-corp')).toThrow(/\[STORE_GRANT_DISCLOSURE_UNAUDITED\]/);
    expect(() => open({})).toThrow(/\[STORE_GRANT_DISCLOSURE_UNAUDITED\]/);
    expect(() => recordStoreGrantDisclosure(GRANT, { tenantSlug: 'acme-corp' })).toThrow(
      /\[STORE_GRANT_UNKNOWN\]/
    );
    audit.record.mockReset();
  });

  it('inside an exact resource ceiling an unpersisted disclosure proceeds with a diagnostic', () => {
    audit.record.mockReset();
    audit.record.mockImplementationOnce(() => {
      throw new Error('[RESOURCE_SCOPE_DENIED] audit file outside the ceiling');
    });
    const ceiling = {
      tenantSlug: 'acme-corp',
      readExact: ['knowledge/personal/tenants/acme-corp.json'],
      writeExact: [],
      mkdirExact: [],
    };
    expect(
      runInResourceAccessScope(ceiling, () =>
        withStoreGrant('workspace_graph_reader', () => 'bounded read', { tenantSlug: '' })
      )
    ).toBe('bounded read');
    expect(audit.record).toHaveBeenCalledTimes(1);
    audit.record.mockReset();
  });
});
