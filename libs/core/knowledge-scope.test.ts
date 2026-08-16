import { describe, expect, it } from 'vitest';
import {
  assertKnowledgePathInScope,
  knowledgeWritePathFor,
  resolveKnowledgeScopeSet,
} from './knowledge-scope.js';

describe('knowledge-scope', () => {
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
