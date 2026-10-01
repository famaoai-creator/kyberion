import { describe, expect, it } from 'vitest';
import {
  connectionReadiness,
  groupConnections,
  visibleConnections,
} from '../src/lib/connection-view';

const records = [
  {
    binding_id: 'b-mail',
    service_id: 'google-workspace',
    owner_kind: 'person',
    owner_ref: 'user:alice',
  },
  {
    binding_id: 'b-bob',
    service_id: 'google-workspace',
    owner_kind: 'person',
    owner_ref: 'user:bob',
  },
  { binding_id: 'b-slack-a', service_id: 'slack', tenant_slug: 'acme' },
  {
    binding_id: 'b-slack-b',
    service_id: 'slack',
    owner_kind: 'organization',
    owner_ref: 'beta',
    tenant_slug: 'beta',
  },
  { binding_id: 'b-whisper', service_id: 'whisper', owner_kind: 'operator' },
  { binding_id: 'b-legacy', service_id: 'notion' },
  { binding_id: 7, service_id: 'x' },
  null,
];

describe('visibleConnections', () => {
  it("a member sees their own connections and their organizations', never another person's or the operator's", () => {
    const alice = visibleConnections(records, {
      loopback: false,
      memberId: 'alice',
      tenantSlugs: ['acme'],
    });
    expect(alice.map((c) => c.binding_id)).toEqual(['b-legacy', 'b-mail', 'b-slack-a']);
    expect(alice.find((c) => c.binding_id === 'b-slack-a')).toMatchObject({
      group: 'organization',
      owner_ref: 'acme',
    });
  });
  it('an unidentified remote viewer sees no personal connection at all', () => {
    const anon = visibleConnections(records, { loopback: false, tenantSlugs: ['acme'] });
    expect(anon.map((c) => c.binding_id)).toEqual(['b-slack-a']);
  });
  it('the local operator keeps legacy and personal connections but still never sees operator-owned ones', () => {
    const local = visibleConnections(records, { loopback: true, tenantSlugs: ['acme'] });
    expect(local.map((c) => c.binding_id)).toEqual(['b-legacy', 'b-mail', 'b-bob', 'b-slack-a']);
    expect(local.some((c) => c.owner_kind === 'operator')).toBe(false);
  });
  it('an all-tenants viewer sees every organization', () => {
    const all = visibleConnections(records, {
      loopback: false,
      memberId: 'alice',
      tenantSlugs: 'all',
    });
    expect(all.filter((c) => c.group === 'organization').map((c) => c.owner_ref)).toEqual([
      'acme',
      'beta',
    ]);
  });
});

describe('groupConnections', () => {
  it("puts the viewer's own first and one block per organization, sorted", () => {
    const items = visibleConnections(records, {
      loopback: false,
      memberId: 'alice',
      tenantSlugs: 'all',
    });
    const grouped = groupConnections(items);
    expect(grouped.mine.map((c) => c.binding_id)).toEqual(['b-legacy', 'b-mail']);
    expect(grouped.organizations.map((o) => o.tenant_slug)).toEqual(['acme', 'beta']);
  });
});

describe('connectionReadiness', () => {
  it('flags a stored-credential connection that references no credential, and nothing else', () => {
    expect(connectionReadiness({ auth_mode: 'secret-guard', secret_refs: [] })).toBe(
      'needs_credential'
    );
    expect(connectionReadiness({ auth_mode: 'secret-guard', secret_refs: [' '] })).toBe(
      'needs_credential'
    );
    expect(connectionReadiness({ auth_mode: 'secret-guard' })).toBe('needs_credential');
    expect(
      connectionReadiness({ auth_mode: 'secret-guard', secret_refs: ['vault://b/x/token'] })
    ).toBe('ready');
    expect(connectionReadiness({ auth_mode: 'session', secret_refs: [] })).toBe('ready');
    expect(connectionReadiness({})).toBe('ready');
  });

  it('is carried on each visible connection', () => {
    const items = visibleConnections(
      [
        {
          binding_id: 'b-x',
          service_id: 'slack',
          owner_kind: 'person',
          owner_ref: 'user:alice',
          auth_mode: 'secret-guard',
          secret_refs: [],
        },
      ],
      { loopback: false, memberId: 'alice', tenantSlugs: [] }
    );
    expect(items[0].readiness).toBe('needs_credential');
  });
});
