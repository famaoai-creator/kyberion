import { describe, expect, it } from 'vitest';
import {
  assertKnowledgePathInScope,
  knowledgeWritePathFor,
  resolveKnowledgeScopeSet,
} from './knowledge-scope.js';

describe('knowledge-scope', () => {
  it('rejects a missing parent rather than placing knowledge at a wider level', () => {
    expect(() =>
      knowledgeWritePathFor(
        {
          tier: 'confidential',
          tenant_slug: 'acme-corp',
          mission_id: 'mission-a',
        },
        'mission',
        'guide'
      )
    ).toThrow();
  });

  it('rejects unknown runtime levels including object prototype keys', () => {
    expect(() =>
      knowledgeWritePathFor(
        { tier: 'confidential', tenant_slug: 'acme-corp' },
        'toString' as Parameters<typeof knowledgeWritePathFor>[1],
        'guide'
      )
    ).toThrow('[KNOWLEDGE_WRITE_INVALID]');
  });

  it.each([
    ['tenant', 'confidential/acme-corp'],
    ['organization', 'confidential/acme-corp/organizations/shared-id'],
    ['project', 'confidential/acme-corp/organizations/shared-id/projects/shared-id'],
    [
      'mission',
      'confidential/acme-corp/organizations/shared-id/projects/shared-id/missions/shared-id',
    ],
    [
      'task',
      'confidential/acme-corp/organizations/shared-id/projects/shared-id/missions/shared-id/tasks/shared-id',
    ],
    [
      'session',
      'confidential/acme-corp/organizations/shared-id/projects/shared-id/missions/shared-id/tasks/shared-id/sessions/shared-id',
    ],
  ] as const)('places %s knowledge at the requested level even when IDs repeat', (level, root) => {
    expect(
      knowledgeWritePathFor(
        {
          tier: 'confidential',
          tenant_slug: 'acme-corp',
          organization_id: 'shared-id',
          project_id: 'shared-id',
          mission_id: 'shared-id',
          task_id: 'shared-id',
          session_id: 'shared-id',
        },
        level,
        'guide'
      )
    ).toBe(`${root}/guide.md`);
  });

  it.each(['../escape', '.md/../../escape', '.md\\escape', '.', ''])(
    'rejects unsafe extension %j',
    (extension) => {
      expect(() => knowledgeWritePathFor({ tier: 'public' }, 'public', 'guide', extension)).toThrow(
        '[KNOWLEDGE_WRITE_INVALID]'
      );
    }
  );

  it('keeps a tenant-bearing public request on public/product roots', () => {
    const scope = resolveKnowledgeScopeSet({ tier: 'public', tenant_slug: 'acme-corp' });
    expect(scope.roots).toEqual(['public', 'product']);
    expect(assertKnowledgePathInScope('confidential/acme-corp/secret.md', scope)).toBe(false);
  });

  it('allows only the current tenant and shared confidential knowledge', () => {
    const scope = resolveKnowledgeScopeSet({ tier: 'confidential', tenant_slug: 'acme-corp' });
    expect(assertKnowledgePathInScope('confidential/acme-corp/guide.md', scope)).toBe(true);
    expect(assertKnowledgePathInScope('confidential/common/policy.md', scope)).toBe(true);
    expect(assertKnowledgePathInScope('confidential/other-corp/secret.md', scope)).toBe(false);
  });

  it('rejects traversal even when normalization would land on an allowed root', () => {
    const scope = resolveKnowledgeScopeSet({ tier: 'public' });
    expect(assertKnowledgePathInScope('other/../public/secret.md', scope)).toBe(false);
    expect(assertKnowledgePathInScope('../public/secret.md', scope)).toBe(false);
  });

  it('requires explicit system authority for a system-wide confidential scan', () => {
    const scope = resolveKnowledgeScopeSet({ tier: 'confidential' }, { systemAuthority: true });
    expect(scope.roots).toContain('confidential');
    expect(assertKnowledgePathInScope('confidential/any-tenant/secret.md', scope)).toBe(true);
  });

  it('writes only to the requested point in the tenant containment chain', () => {
    const path = knowledgeWritePathFor(
      {
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        organization_id: 'org-a',
        project_id: 'project-a',
      },
      'project',
      'rollback guide'
    );
    expect(path).toBe(
      'confidential/acme-corp/organizations/org-a/projects/project-a/rollback-guide.md'
    );
    expect(() =>
      knowledgeWritePathFor({ tier: 'public', tenant_slug: 'acme-corp' }, 'tenant', 'secret')
    ).toThrow('[KNOWLEDGE_WRITE_INVALID]');
  });
});
