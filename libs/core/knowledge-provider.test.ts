import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeProvider } from './knowledge-provider.js';

afterEach(() => KnowledgeProvider.disableMockMode());

describe('KnowledgeProvider scope boundary', () => {
  it('allows only public and product knowledge by default', () => {
    KnowledgeProvider.enableMockMode({
      'product/rules.json': { ok: true },
      'public/guide.md': 'ok',
    });

    expect(KnowledgeProvider.getJson('product/rules.json')).toEqual({ ok: true });
    expect(KnowledgeProvider.getText('public/guide.md')).toBe('ok');
    expect(() => KnowledgeProvider.getText('confidential/tenant-a/secret.md')).toThrow(
      '[KNOWLEDGE_SCOPE_DENIED]'
    );
  });

  it('allows a matching tenant subtree but denies another tenant and traversal', () => {
    KnowledgeProvider.enableMockMode({
      'confidential/tenant-a/secret.md': 'allowed',
    });
    const scope = { tier: 'confidential' as const, tenant_slug: 'tenant-a' };

    expect(KnowledgeProvider.getText('confidential/tenant-a/secret.md', undefined, { scope })).toBe(
      'allowed'
    );
    expect(() =>
      KnowledgeProvider.getText('confidential/tenant-b/secret.md', undefined, { scope })
    ).toThrow('[KNOWLEDGE_SCOPE_DENIED]');
    expect(() =>
      KnowledgeProvider.getText('confidential/tenant-a/../tenant-b/secret.md', undefined, { scope })
    ).toThrow('[KNOWLEDGE_SCOPE_DENIED]');
  });

  it('requires explicit system authority for global confidential knowledge', () => {
    KnowledgeProvider.enableMockMode({ 'confidential/tenant-a/policy.md': 'system-only' });
    const scope = { tier: 'personal' as const, tenant_slug: 'tenant-a' };

    expect(() =>
      KnowledgeProvider.getText('confidential/tenant-a/policy.md', undefined, { scope })
    ).toThrow('[KNOWLEDGE_SCOPE_DENIED]');
    expect(
      KnowledgeProvider.getText('confidential/tenant-a/policy.md', undefined, {
        scope,
        systemAuthority: true,
      })
    ).toBe('system-only');
  });
});
