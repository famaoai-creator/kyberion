import { describe, expect, it } from 'vitest';
import { safeReadFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import type { ResourceAccessScope } from './resource-access-scope.js';
import {
  narrowDeclarationValid,
  roleNarrowAllowsStructuralMkdir,
  roleNarrowingDenial,
} from './role-narrowing-denial.js';

/**
 * G3 decision matrix of the `narrow` declarations, asserted through the real
 * security-policy.json — the same decisions the per-role modules
 * (`narrow-store-role-denial.ts`, the Concierge role-name branches) made before.
 */
const POLICY = JSON.parse(
  safeReadFile(pathResolver.knowledge('product/governance/security-policy.json'), {
    encoding: 'utf8',
  }) as string
) as unknown;

const deny = (input: {
  role: string | undefined;
  relativePath: string;
  operation: 'read' | 'write' | 'append' | 'mkdir' | 'metadata';
  scope?: ResourceAccessScope;
  content?: string | Buffer;
  previous?: string;
}) =>
  roleNarrowingDenial({
    policy: POLICY,
    role: input.role,
    relativePath: input.relativePath,
    operation: input.operation,
    scope: input.scope,
    content: input.content,
    readRepoFile: () => input.previous,
  });

const INBOX = 'active/shared/inbox/entries.jsonl';
const LOCK = `active/shared/runtime/locks/deliverable-inbox-${'a'.repeat(64)}.lock`;
const BINDINGS = 'knowledge/confidential/acme-corp/connections/channel-bindings.json';
const ARCHIVED = 'active/archive/missions/confidential/acme-corp/MSN-X/mission-state.json';

const archivedScope: ResourceAccessScope = {
  tenantSlug: 'acme-corp',
  readExact: [ARCHIVED],
  writeExact: [],
  mkdirExact: [],
  allowProductKnowledgeRead: true,
};

const readerScope: ResourceAccessScope = {
  tenantSlug: 'acme-corp',
  readExact: ['active/organizations/public/acme-corp/'],
  writeExact: [],
  mkdirExact: [],
  allowProductKnowledgeRead: true,
};

const writerScope: ResourceAccessScope = {
  ...readerScope,
  organizationId: 'org-1',
};

describe('deliverable_inbox_writer narrowing declaration', () => {
  it('allows reads and metadata anywhere in its policy grant', () => {
    expect(
      deny({ role: 'deliverable_inbox_writer', relativePath: 'active/shared/x', operation: 'read' })
    ).toBeNull();
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: 'active/shared/x',
        operation: 'metadata',
      })
    ).toBeNull();
  });

  it('writes only the entries file and its own lock', () => {
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: 'active/shared/runtime/state.json',
        operation: 'write',
        content: '',
      })
    ).toContain('DELIVERABLE_INBOX_WRITER_SCOPE');
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: LOCK,
        operation: 'write',
        content: '',
      })
    ).toBeNull();
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: 'active/shared/runtime/locks/../x.lock',
        operation: 'write',
        content: '',
      })
    ).toContain('DELIVERABLE_INBOX_WRITER_SCOPE');
  });

  it('creates only the inbox and lock directories', () => {
    for (const dir of [
      'active/shared/inbox',
      'active/shared/runtime',
      'active/shared/runtime/locks',
    ])
      expect(
        deny({
          role: 'deliverable_inbox_writer',
          relativePath: dir,
          operation: 'mkdir',
        })
      ).toBeNull();
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: 'active/shared/runtime/elsewhere',
        operation: 'mkdir',
      })
    ).toContain('DELIVERABLE_INBOX_WRITER_SCOPE');
  });

  it('checks the entries file content on write and append', () => {
    const previous = '{"entry_id":"INBOX-1"}\n';
    const appended = `${previous}{"entry_id":"INBOX-2"}\n`;
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: INBOX,
        operation: 'write',
        content: appended,
        previous,
      })
    ).toBeNull();
    // Content the guard cannot check is refused.
    expect(
      deny({ role: 'deliverable_inbox_writer', relativePath: INBOX, operation: 'write' })
    ).toContain('DELIVERABLE_INBOX_WRITE_REFUSED');
    // Dropping or rewriting an existing line is refused.
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: INBOX,
        operation: 'write',
        content: '{"entry_id":"INBOX-2"}\n',
        previous,
      })
    ).toContain('DELIVERABLE_INBOX_WRITE_REFUSED');
    // A reused or missing entry_id, and a non-JSON line, are refused.
    for (const bad of [
      `${previous}{"entry_id":"INBOX-1"}\n`,
      `${previous}{"title":"no id"}\n`,
      `${previous}not json\n`,
    ])
      expect(
        deny({
          role: 'deliverable_inbox_writer',
          relativePath: INBOX,
          operation: 'write',
          content: bad,
          previous,
        })
      ).toContain('DELIVERABLE_INBOX_WRITE_REFUSED');
    // Append keeps every write restriction (the old append→write mapping).
    expect(
      deny({
        role: 'deliverable_inbox_writer',
        relativePath: 'active/shared/runtime/state.json',
        operation: 'append',
        content: 'x',
      })
    ).toContain('DELIVERABLE_INBOX_WRITER_SCOPE');
    expect(
      deny({ role: 'deliverable_inbox_writer', relativePath: INBOX, operation: 'append' })
    ).toContain('DELIVERABLE_INBOX_WRITE_REFUSED');
  });
});

describe('customer_channel_binding_store narrowing declaration', () => {
  it('leaves reads, metadata and append outside its path rules to the grant', () => {
    for (const operation of ['read', 'metadata'] as const)
      expect(
        deny({
          role: 'customer_channel_binding_store',
          relativePath: 'knowledge/confidential/acme-corp/connections/x.json',
          operation,
        })
      ).toBeNull();
    // Append inherits the write path restriction.
    expect(
      deny({
        role: 'customer_channel_binding_store',
        relativePath: 'knowledge/confidential/acme-corp/x.json',
        operation: 'append',
        content: 'x',
      })
    ).toContain('CUSTOMER_CHANNEL_BINDING_STORE_SCOPE');
    expect(
      deny({
        role: 'customer_channel_binding_store',
        relativePath: BINDINGS,
        operation: 'append',
        content: 'x',
      })
    ).toBeNull();
  });

  it('writes only the bound tenant channel-bindings file', () => {
    expect(
      deny({
        role: 'customer_channel_binding_store',
        relativePath: BINDINGS,
        operation: 'write',
        content: '{}',
      })
    ).toBeNull();
    // The pattern is tenant-shape only; which tenant the role may actually
    // reach is the policy grant's and the tenant-scope check's job.
    expect(
      deny({
        role: 'customer_channel_binding_store',
        relativePath: 'knowledge/confidential/other-tn/connections/channel-bindings.json',
        operation: 'write',
        content: '{}',
      })
    ).toBeNull();
    for (const other of [
      'knowledge/confidential/acme-corp/connections/secrets.json',
      'knowledge/confidential/a/connections/channel-bindings.json',
      'active/shared/runtime/state.json',
      'knowledge/confidential/acme-corp/connections/../x/channel-bindings.json',
    ])
      expect(
        deny({
          role: 'customer_channel_binding_store',
          relativePath: other,
          operation: 'write',
          content: '{}',
        })
      ).toContain('CUSTOMER_CHANNEL_BINDING_STORE_SCOPE');
  });

  it('creates only the directories leading to the bindings file', () => {
    for (const dir of [
      'knowledge/confidential',
      'knowledge/confidential/acme-corp',
      'knowledge/confidential/acme-corp/connections',
    ])
      expect(
        deny({
          role: 'customer_channel_binding_store',
          relativePath: dir,
          operation: 'mkdir',
        })
      ).toBeNull();
    expect(
      deny({
        role: 'customer_channel_binding_store',
        relativePath: 'knowledge/confidential/acme-corp/elsewhere',
        operation: 'mkdir',
      })
    ).toContain('CUSTOMER_CHANNEL_BINDING_STORE_SCOPE');
  });
});

describe('archived_mission_state_reader narrowing declaration', () => {
  it('never writes, appends or creates directories', () => {
    for (const operation of ['write', 'append', 'mkdir'] as const)
      expect(
        deny({
          role: 'archived_mission_state_reader',
          relativePath: ARCHIVED,
          operation,
          scope: archivedScope,
          content: '',
        })
      ).toContain('RESOURCE_SCOPE_REQUIRED');
  });

  it('reads and inspects metadata only under its exact read-only capability of the same tenant', () => {
    for (const operation of ['read', 'metadata'] as const)
      expect(
        deny({
          role: 'archived_mission_state_reader',
          relativePath: ARCHIVED,
          operation,
          scope: archivedScope,
        })
      ).toBeNull();
    // No scope, a writable ceiling, a different tenant or a non-archive path.
    for (const scope of [
      undefined,
      readerScope,
      { ...archivedScope, writeExact: ['active/shared/x'] },
      {
        ...archivedScope,
        tenantSlug: 'other-tn',
      },
      {
        ...archivedScope,
        readExact: ['active/archive/missions/confidential/acme-corp/MSN-X/other.json'],
      },
    ])
      for (const operation of ['read', 'metadata'] as const)
        expect(
          deny({
            role: 'archived_mission_state_reader',
            relativePath: ARCHIVED,
            operation,
            scope,
          })
        ).toContain('RESOURCE_SCOPE_REQUIRED');
  });
});

describe('concierge management narrowing declarations', () => {
  it('reader needs a capability and never writes', () => {
    expect(
      deny({
        role: 'concierge_management_reader',
        relativePath: 'knowledge/personal/members/x.json',
        operation: 'read',
      })
    ).toContain('RESOURCE_SCOPE_REQUIRED');
    expect(
      deny({
        role: 'concierge_management_reader',
        relativePath: 'knowledge/personal/members/x.json',
        operation: 'read',
        scope: readerScope,
      })
    ).toBeNull();
    for (const operation of ['write', 'append', 'mkdir'] as const)
      expect(
        deny({
          role: 'concierge_management_reader',
          relativePath: 'active/projects/public/acme-corp/x.json',
          operation,
          scope: readerScope,
          content: '{}',
        })
      ).toContain('RESOURCE_SCOPE_REQUIRED');
  });

  it('writer needs an organization-bound capability for every operation', () => {
    for (const scope of [undefined, readerScope])
      expect(
        deny({
          role: 'concierge_management_writer',
          relativePath: 'active/projects/public/acme-corp/x.json',
          operation: 'read',
          scope,
        })
      ).toContain('RESOURCE_SCOPE_REQUIRED');
    for (const operation of ['read', 'write', 'append', 'mkdir', 'metadata'] as const)
      expect(
        deny({
          role: 'concierge_management_writer',
          relativePath: 'active/projects/public/acme-corp/x.json',
          operation,
          scope: writerScope,
          content: '{}',
        })
      ).toBeNull();
  });

  it('marks only the writer structural-mkdir capable', () => {
    expect(roleNarrowAllowsStructuralMkdir(POLICY, 'concierge_management_writer')).toBe(true);
    expect(roleNarrowAllowsStructuralMkdir(POLICY, 'concierge_management_reader')).toBe(false);
    expect(roleNarrowAllowsStructuralMkdir(POLICY, 'deliverable_inbox_writer')).toBe(false);
    expect(roleNarrowAllowsStructuralMkdir(POLICY, undefined)).toBe(false);
  });
});

describe('narrow declaration evaluation itself', () => {
  it('does nothing without a role or a declaration', () => {
    expect(
      deny({ role: undefined, relativePath: 'x', operation: 'write', content: '' })
    ).toBeNull();
    expect(
      deny({ role: 'surface_runtime', relativePath: 'x', operation: 'write', content: '' })
    ).toBeNull();
  });

  it('fails closed on a malformed declaration', () => {
    for (const narrow of [
      'not-an-object',
      { deny: 'write' },
      { deny: [] },
      { deny: ['explode'] },
      { deny: [['write']] },
      { deny: ['append'] },
      { only: 'x' },
      { only: { write: 'x' } },
      { only: { write: [] } },
      { only: { append: [{ path: 'x' }] } },
      { only: { write: [{}] } },
      { only: { write: [{ pattern: '(' }] } },
      { only: { write: [{ path: 3 }] } },
      { content_check: [] },
      { content_check: [{ path: 'x', kind: 'other', id_field: 'y' }] },
      {
        content_check: [{ path: 'x', kind: 'append_only_jsonl', id_field: 'y', refusal_prefix: 1 }],
      },
      { require_scope: 'x' },
      { require_scope: { fields: 'organizationId' } },
      { require_scope: { fields: [3] } },
      { require_scope: { reason: 5 } },
      { require_scope: { exact: { read_only: 'yes' } } },
      { require_scope: { exact: { allow_product_knowledge_read: 1 } } },
      { require_scope: { exact: { read_path_tenant_group: 'two' } } },
      { require_scope: { exact: { read_path_tenant_group: 0 } } },
      { require_scope: { exact: { read_path_pattern: 7 } } },
      { require_scope: { exact: { read_path_pattern: '(' } } },
      { deny_reason: 42 },
      { structural_mkdir: 'yes' },
    ]) {
      expect(narrowDeclarationValid(narrow)).toBe(false);
      const reason = roleNarrowingDenial({
        policy: { authority_role_permissions: { bad_role: { narrow } } },
        role: 'bad_role',
        relativePath: 'x',
        operation: 'read',
        scope: undefined,
        content: undefined,
        readRepoFile: () => undefined,
      });
      expect(reason).toContain('ROLE_NARROWING_INVALID');
    }
  });

  it('accepts the declared shapes', () => {
    expect(
      narrowDeclarationValid({
        deny: ['write', 'mkdir'],
        only: { write: [{ path: 'a/b' }, { prefix: 'a/' }, { pattern: '^a/' }] },
        content_check: [{ path: 'a/b', kind: 'append_only_jsonl', id_field: 'id' }],
        require_scope: { fields: ['organizationId'], exact: { read_only: true } },
        structural_mkdir: true,
      })
    ).toBe(true);
  });
});
