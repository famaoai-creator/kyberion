import { describe, expect, it } from 'vitest';
import {
  compileScopedContextPack,
  validateContextOutputTier,
  type ContextSecurityScope,
  type GovernedContextFragment,
} from './context-security-scope.js';

const scope: ContextSecurityScope = {
  tenant_id: 'tenant-a',
  organization_id: 'org-a',
  project_id: 'project-x',
  mission_id: 'MSN-123',
  participant_id: 'security-review',
  read_tiers: ['public', 'confidential'],
  write_tier: 'confidential',
  purpose: 'security-review',
};

function fragment(
  overrides: Partial<GovernedContextFragment<string>> = {}
): GovernedContextFragment<string> {
  return {
    fragment_id: 'CTX-001',
    source_ref: 'knowledge/confidential/tenant-a/project-x/decision.md',
    source_tier: 'confidential',
    tenant_id: 'tenant-a',
    organization_id: 'org-a',
    project_id: 'project-x',
    mission_id: 'MSN-123',
    purpose_tags: ['security-review'],
    content: 'bounded context',
    ...overrides,
  };
}

describe('compileScopedContextPack', () => {
  it('keeps matching confidential and shared public fragments', () => {
    const result = compileScopedContextPack(scope, [
      fragment(),
      fragment({
        fragment_id: 'CTX-PUBLIC',
        source_ref: 'knowledge/public/standards/security.md',
        source_tier: 'public',
        tenant_id: undefined,
        organization_id: undefined,
        project_id: undefined,
        mission_id: undefined,
        purpose_tags: undefined,
      }),
    ]);

    expect(result.fragments.map((entry) => entry.fragment_id)).toEqual(['CTX-001', 'CTX-PUBLIC']);
    expect(result.rejected).toEqual([]);
    expect(result.effective_input_tier).toBe('confidential');
  });

  it('rejects same-tier context from another tenant before retrieval', () => {
    const result = compileScopedContextPack(scope, [fragment({ tenant_id: 'tenant-b' })]);

    expect(result.fragments).toEqual([]);
    expect(result.rejected[0]?.code).toBe('TENANT_SCOPE_MISMATCH');
  });

  it('rejects project, mission, purpose, and unreadable tier mismatches', () => {
    const result = compileScopedContextPack(scope, [
      fragment({ fragment_id: 'PROJECT', project_id: 'project-y' }),
      fragment({ fragment_id: 'MISSION', mission_id: 'MSN-999' }),
      fragment({ fragment_id: 'PURPOSE', purpose_tags: ['sales-review'] }),
      fragment({ fragment_id: 'PERSONAL', source_tier: 'personal' }),
    ]);

    expect(result.rejected.map((entry) => entry.code)).toEqual([
      'PROJECT_SCOPE_MISMATCH',
      'MISSION_SCOPE_MISMATCH',
      'PURPOSE_SCOPE_MISMATCH',
      'TIER_NOT_READABLE',
    ]);
  });

  it('fails closed when the security scope is incomplete', () => {
    expect(() => compileScopedContextPack({ ...scope, tenant_id: '' }, [fragment()])).toThrow(
      '[CONTEXT_SCOPE_INVALID]'
    );
  });
});

describe('validateContextOutputTier', () => {
  it('blocks confidential context from being persisted as public', () => {
    const pack = compileScopedContextPack(scope, [fragment()]);
    expect(validateContextOutputTier(pack, 'public')).toEqual({
      allowed: false,
      reason:
        '[CONTEXT_TIER_DOWNFLOW] confidential context cannot be persisted as public without promotion',
    });
  });

  it('allows persistence at the effective input tier', () => {
    const pack = compileScopedContextPack(scope, [fragment()]);
    expect(validateContextOutputTier(pack, 'confidential')).toEqual({ allowed: true });
  });
});
