import { describe, expect, it } from 'vitest';
import type { AgentIdentityRecord } from './agent/agent-identity.js';
import { resolvePersonaIdentity, validatePersonaIdentityBindings } from './persona-identity.js';

const personal = 'kyberion://agent/personal/haru';
const first = 'kyberion://agent/shared-org/haru-a';
const second = 'kyberion://agent/shared-org/haru-b';
const bindings = {
  version: 1,
  persona_id: 'haru',
  accountable_human_id: 'user:owner',
  personal_nhi_id: personal,
  tenant_bindings: [
    { tenant_slug: 'company-a', nhi_id: first },
    { tenant_slug: 'company-b', nhi_id: second },
  ],
};
const profile = { agent_id: 'haru', nhi_id: personal, persona_identity_bindings: bindings };
function records(): Record<string, AgentIdentityRecord> {
  return Object.fromEntries(
    [
      [personal, undefined],
      [first, 'company-a'],
      [second, 'company-b'],
    ].map(([id, tenant]) => [
      id!,
      {
        nhi_id: id!,
        kind: 'agent',
        display_name: 'Haru',
        accountable_human_id: 'user:owner',
        affiliation: { organization_id: 'shared-org', ...(tenant ? { tenant_slug: tenant } : {}) },
        lifecycle_status: 'provisioned',
        created_at: '2026-11-04T00:00:00Z',
      },
    ])
  );
}
const scope = (tenantSlug?: string) =>
  tenantSlug
    ? { kind: 'tenant' as const, accountableHumanId: 'user:owner', tenantSlug }
    : { kind: 'person' as const, accountableHumanId: 'user:owner' };

describe('conversational persona identity bindings', () => {
  it('resolves one persona to distinct personal and two tenant identities without changing records', () => {
    const ledger = records();
    const before = structuredClone(ledger);
    const lookup = (id: string) => ledger[id];
    expect(validatePersonaIdentityBindings(profile, bindings, lookup)).toEqual(bindings);
    expect(resolvePersonaIdentity(profile, scope(), lookup)?.nhi_id).toBe(personal);
    expect(resolvePersonaIdentity(profile, scope('company-a'), lookup)?.nhi_id).toBe(first);
    expect(resolvePersonaIdentity(profile, scope('company-b'), lookup)?.nhi_id).toBe(second);
    expect(resolvePersonaIdentity(profile, scope('unknown-tenant'), lookup)).toBeNull();
    expect(ledger).toEqual(before);
  });

  it('never promotes a legacy personal name into tenant authority or trusts an unregistered name', () => {
    const ledger = records();
    const legacy = { agent_id: 'haru', nhi_id: personal };
    expect(resolvePersonaIdentity(legacy, scope(), (id) => ledger[id])?.nhi_id).toBe(personal);
    expect(resolvePersonaIdentity(legacy, scope('company-a'), (id) => ledger[id])).toBeNull();
    expect(resolvePersonaIdentity(legacy, scope(), () => null)).toBeNull();
    expect(
      resolvePersonaIdentity(
        { ...profile, persona_identity_bindings: {} },
        scope(),
        (id) => ledger[id]
      )
    ).toBeNull();
  });

  it.each(['suspended', 'retired'] as const)('fails closed for %s identities', (status) => {
    const ledger = records();
    ledger[first].lifecycle_status = status;
    expect(resolvePersonaIdentity(profile, scope('company-a'), (id) => ledger[id])).toBeNull();
    expect(() => validatePersonaIdentityBindings(profile, bindings, (id) => ledger[id])).toThrow();
  });

  it('rejects accountability, persona and explicit tenant mismatches even when org names match', () => {
    const ledger = records();
    const lookup = (id: string) => ledger[id];
    expect(resolvePersonaIdentity({ ...profile, agent_id: 'other' }, scope(), lookup)).toBeNull();
    ledger[first].affiliation = { organization_id: 'company-a', tenant_slug: 'company-b' };
    expect(resolvePersonaIdentity(profile, scope('company-a'), lookup)).toBeNull();
    ledger[personal].accountable_human_id = 'user:other';
    expect(resolvePersonaIdentity(profile, scope(), lookup)).toBeNull();
  });

  it('rejects reused identities, duplicate tenants and authority-shaped metadata', () => {
    const lookup = (id: string) => records()[id];
    expect(() =>
      validatePersonaIdentityBindings(
        profile,
        {
          ...bindings,
          tenant_bindings: [bindings.tenant_bindings[0], bindings.tenant_bindings[0]],
        },
        lookup
      )
    ).toThrow();
    expect(() =>
      validatePersonaIdentityBindings(profile, { ...bindings, personal_nhi_id: first }, lookup)
    ).toThrow();
    expect(() =>
      validatePersonaIdentityBindings(profile, { ...bindings, role: 'owner' }, lookup)
    ).toThrow();
  });
});
