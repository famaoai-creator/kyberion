import { describe, expect, it } from 'vitest';
import { canPromoteKnowledge, resolveKnowledgeContext } from './knowledge-context.js';

describe('knowledge context', () => {
  it('defaults capture to local-only until-distilled handling', () => {
    const context = resolveKnowledgeContext({
      purpose: 'capture',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      provenance_refs: ['active/missions/confidential/tenant-a/run/evidence.md'],
    });
    expect(context.retention).toBe('until_distilled');
    expect(context.training_use).toBe('local_only');
  });

  it('requires a redacted provenance-bearing context to publish restricted knowledge', () => {
    expect(() =>
      resolveKnowledgeContext({
        purpose: 'publish',
        tier: 'confidential',
        tenant_slug: 'tenant-a',
      })
    ).toThrow(/requires redaction/i);

    const context = resolveKnowledgeContext({
      purpose: 'promote',
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      redacted: true,
      provenance_refs: ['active/missions/confidential/tenant-a/run/evidence.md'],
    });
    expect(canPromoteKnowledge(context, 'public')).toBe(true);
  });

  it('keeps personal memory attributable to an owner or audience', () => {
    expect(() => resolveKnowledgeContext({ purpose: 'capture', tier: 'personal' })).toThrow(
      /owner_nhi or allowed_audience/i
    );
    expect(
      resolveKnowledgeContext({ purpose: 'capture', tier: 'personal', owner_nhi: 'human:alice' })
        .owner_nhi
    ).toBe('human:alice');
  });
});
