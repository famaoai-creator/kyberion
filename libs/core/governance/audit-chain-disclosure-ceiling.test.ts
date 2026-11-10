import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withStoreGrant } from '../authority.js';
import { scopedAssumedRole } from '../foundation/execution-scope.js';
import {
  currentResourceAccessScope,
  runInResourceAccessScope,
} from '../foundation/resource-access-scope.js';
import { validateWritePermission } from '../tier-guard.js';
import { registerAuditChainIo, type AuditChainIo } from './audit-chain.js';

// S4 (scope model P4): a disclosure store grant opened by a caller that is
// already inside an exact resource ceiling must still be recorded. The record
// (grant, principal, bound scope, operation — no tenant content) is appended by
// the audit chain's own store writer outside the ceiling; a record that does
// not land refuses the read. The fixture I/O enforces the tier guard on every
// append, as secure-io does.
const ENV_KEYS = ['KYBERION_PERSONA', 'MISSION_ROLE', 'SYSTEM_ROLE', 'KYBERION_TENANT'] as const;
const CEILING = {
  tenantSlug: 'acme-corp',
  readExact: ['knowledge/confidential/acme-corp/catalog.json'],
  writeExact: [],
  mkdirExact: [],
};

describe('store grant disclosure record inside an exact resource ceiling', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let restoreAuditIo: (() => void) | undefined;
  let appends: Array<{
    file: string;
    role: string | undefined;
    inCeiling: boolean;
    content: string;
  }>;
  let failAppend: boolean;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    appends = [];
    failAppend = false;
    const io: AuditChainIo = {
      read: () => '',
      loadJson: <T>() => ({}) as T,
      exists: () => false,
      mkdir: () => undefined,
      readdir: () => [],
      append: (file, content) => {
        if (failAppend) throw new Error('audit volume read-only');
        if (!validateWritePermission(file).allowed)
          throw new Error(`[RESOURCE_SCOPE_DENIED] ${file}`);
        appends.push({
          file,
          role: scopedAssumedRole(),
          inCeiling: currentResourceAccessScope() !== undefined,
          content,
        });
      },
      assertSafePath: (file) => file,
    };
    restoreAuditIo = registerAuditChainIo(io);
  });

  afterEach(() => {
    restoreAuditIo?.();
    restoreAuditIo = undefined;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('persists the disclosure as the audit store writer outside the ceiling, then reads inside it', () => {
    const read = vi.fn(() => currentResourceAccessScope()?.tenantSlug);
    const result = runInResourceAccessScope(CEILING, () =>
      withStoreGrant('workspace_graph_reader', read, { tenantSlug: '' })
    );
    expect(result).toBe('acme-corp');
    const master = appends.filter((entry) =>
      entry.file.includes(path.join('shared', 'logs', 'audit'))
    );
    expect(master).toEqual([
      {
        file: expect.stringContaining(path.join('shared', 'logs', 'audit')),
        role: 'audit_mirror_writer',
        inCeiling: false,
        content: expect.stringContaining('store_grant.disclosure'),
      },
    ]);
  });

  it('writes a system-scope record whatever the caller and bound tenants are', () => {
    // A process whose ambient tenant differs from the grant's bound tenant (a
    // multi-tenant surface serving one tenant's request): the record names the
    // bound tenant only in its metadata, in the master chain, never in a tenant mirror.
    process.env.KYBERION_TENANT = 'ambient-co';
    const read = vi.fn(() => 'read');
    expect(
      runInResourceAccessScope(CEILING, () =>
        withStoreGrant('concierge_management_reader', read, { tenantSlug: 'acme-corp' })
      )
    ).toBe('read');
    expect(appends).toHaveLength(1);
    expect(appends[0]!.file).toContain(path.join('shared', 'logs', 'audit'));
    const entry = JSON.parse(appends[0]!.content.trim());
    expect(entry.tenantSlug).toBeUndefined();
    expect(entry).toMatchObject({
      action: 'store_grant.disclosure',
      operation: 'concierge_management_reader',
      metadata: { bound_tenant: 'acme-corp', caller_tenant: 'ambient-co' },
    });
  });

  it('refuses the read when the record does not land', () => {
    failAppend = true;
    const read = vi.fn();
    expect(() =>
      runInResourceAccessScope(CEILING, () =>
        withStoreGrant('workspace_graph_reader', read, { tenantSlug: '' })
      )
    ).toThrow(/\[STORE_GRANT_DISCLOSURE_UNAUDITED\][\s\S]*\[AUDIT_CHAIN_PERSIST_FAILED\]/);
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves the caller no write outside its ceiling', () => {
    // The ceiling exit covers only the audit chain's append, never the caller.
    runInResourceAccessScope(CEILING, () =>
      withStoreGrant(
        'workspace_graph_reader',
        () => {
          expect(validateWritePermission('active/shared/logs/audit/audit-x.jsonl').allowed).toBe(
            false
          );
        },
        { tenantSlug: '' }
      )
    );
    expect(appends.length).toBeGreaterThan(0);
  });
});
